// Adds and removes Overlord's command hooks in a Claude Code settings file.
// Our entries are the ones whose command contains "overlord-hook". Everything
// else in the file is kept as is, in its original order.

import {
  copyFile,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { KnownEventName } from './payloads.js';

export const HOOK_MARKER = 'overlord-hook';

/** Seconds. PermissionRequest waits on the user, everything else must be quick. */
export const PERMISSION_TIMEOUT_S = 600;
export const EVENT_TIMEOUT_S = 5;

export const DEFAULT_HOOK_EVENTS: readonly KnownEventName[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PreCompact',
  'PostCompact',
  'InstructionsLoaded',
];

export interface InstallOptions {
  readonly settingsFile: string;
  /** Must contain "overlord-hook", which is how we find our entries again. */
  readonly hookCommand: string;
  readonly events?: readonly string[];
  /** Seconds each event's hook may run. Claude Code's limits when left out. */
  readonly timeoutFor?: (event: string) => number;
}

export interface SettingsFileOptions {
  readonly settingsFile: string;
}

export interface ChangeResult {
  readonly changed: boolean;
}

type JsonObject = Readonly<Record<string, unknown>>;

const handlerSchema = z.looseObject({ type: z.string(), command: z.string().optional() });
const groupSchema = z.looseObject({ hooks: z.array(handlerSchema) });
const hooksBlockSchema = z.record(z.string(), z.array(groupSchema));
const settingsSchema = z.record(z.string(), z.unknown());

type HandlerEntry = z.infer<typeof handlerSchema>;
type GroupEntry = z.infer<typeof groupSchema>;
type HooksBlock = z.infer<typeof hooksBlockSchema>;

export function hookTimeoutFor(event: string): number {
  return event === 'PermissionRequest' ? PERMISSION_TIMEOUT_S : EVENT_TIMEOUT_S;
}

function isOverlordHandler(handler: HandlerEntry): boolean {
  return handler.type === 'command' && (handler.command?.includes(HOOK_MARKER) ?? false);
}

function hooksBlockOf(settings: JsonObject): HooksBlock {
  if (settings['hooks'] === undefined) {
    return {};
  }
  const parsed = hooksBlockSchema.safeParse(settings['hooks']);
  if (!parsed.success) {
    throw new Error('the settings file has a "hooks" block in a shape Overlord does not recognize');
  }
  return parsed.data;
}

function withHooks(settings: JsonObject, hooks: HooksBlock): JsonObject {
  if (Object.keys(hooks).length > 0) {
    return { ...settings, hooks };
  }
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key !== 'hooks') {
      rest[key] = value;
    }
  }
  return rest;
}

function stripGroups(groups: readonly GroupEntry[]): GroupEntry[] {
  const kept: GroupEntry[] = [];
  for (const group of groups) {
    const handlers = group.hooks.filter((handler) => !isOverlordHandler(handler));
    if (handlers.length === group.hooks.length) {
      kept.push(group);
    } else if (handlers.length > 0) {
      kept.push({ ...group, hooks: handlers });
    }
  }
  return kept;
}

export function overlordEvents(settings: JsonObject): string[] {
  return Object.entries(hooksBlockOf(settings))
    .filter(([, groups]) =>
      groups.some((group) => group.hooks.some((handler) => isOverlordHandler(handler))),
    )
    .map(([event]) => event);
}

/** Settings with every Overlord handler removed, and any group or event left empty dropped. */
export function removeOverlordHooks(settings: JsonObject): JsonObject {
  const block = hooksBlockOf(settings);
  if (overlordEvents(settings).length === 0) {
    return settings;
  }
  const hooks: Record<string, GroupEntry[]> = {};
  for (const [event, groups] of Object.entries(block)) {
    const kept = stripGroups(groups);
    if (kept.length > 0) {
      hooks[event] = kept;
    }
  }
  return withHooks(settings, hooks);
}

/** Settings with exactly one Overlord handler per event, appended after the user's own hooks. */
export function addOverlordHooks(
  settings: JsonObject,
  hookCommand: string,
  events: readonly string[],
  timeoutFor: (event: string) => number = hookTimeoutFor,
): JsonObject {
  if (!hookCommand.includes(HOOK_MARKER)) {
    throw new Error(`the hook command must contain "${HOOK_MARKER}"`);
  }
  const base = removeOverlordHooks(settings);
  const hooks: Record<string, GroupEntry[]> = { ...hooksBlockOf(base) };
  for (const event of new Set(events)) {
    const handler = { type: 'command', command: hookCommand, timeout: timeoutFor(event) };
    hooks[event] = [...(hooks[event] ?? []), { hooks: [handler] }];
  }
  return withHooks(base, hooks);
}

/** The real file behind a path, following symlinks even when the target does not exist yet. */
export async function resolveTarget(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    try {
      return path.resolve(path.dirname(file), await readlink(file));
    } catch {
      return file;
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

interface SettingsText {
  readonly text: string | null;
  readonly settings: JsonObject;
}

async function readSettings(file: string): Promise<SettingsText> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    // Only a missing file counts as empty. Anything else (a directory, no
    // permission) must stop us before we write over it.
    if (isMissing(error)) {
      return { text: null, settings: {} };
    }
    throw error;
  }
  if (text.trim() === '') {
    return { text, settings: {} };
  }
  const parsed = settingsSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`${file} does not hold a JSON object`);
  }
  return { text, settings: parsed.data };
}

async function fileMode(file: string): Promise<number> {
  try {
    const info = await stat(file);
    return info.mode & 0o777;
  } catch {
    return 0o600;
  }
}

/** Writes through to the real file: a backup, then a temp file renamed over the target. */
async function writeSettings(target: string, previous: string | null, next: string): Promise<void> {
  const mode = await fileMode(target);
  const temporary = `${target}.overlord-${String(process.pid)}-${String(Date.now())}.tmp`;
  try {
    await writeFile(temporary, next, { encoding: 'utf8', mode });
    if (previous !== null) {
      await copyFile(target, `${target}.bak`);
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function update(
  settingsFile: string,
  change: (settings: JsonObject) => JsonObject,
): Promise<ChangeResult> {
  const target = await resolveTarget(settingsFile);
  const { text, settings } = await readSettings(target);
  const next = change(settings);
  if (JSON.stringify(settings) === JSON.stringify(next)) {
    return { changed: false };
  }
  await writeSettings(target, text, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true };
}

export async function installHooks(options: InstallOptions): Promise<ChangeResult> {
  const events = options.events ?? DEFAULT_HOOK_EVENTS;
  return update(options.settingsFile, (settings) =>
    addOverlordHooks(settings, options.hookCommand, events, options.timeoutFor),
  );
}

export async function uninstallHooks(options: SettingsFileOptions): Promise<ChangeResult> {
  return update(options.settingsFile, removeOverlordHooks);
}

/** Events that currently have an Overlord hook in the file. */
export async function installedEvents(options: SettingsFileOptions): Promise<string[]> {
  const { settings } = await readSettings(await resolveTarget(options.settingsFile));
  return overlordEvents(settings);
}

export async function isInstalled(options: SettingsFileOptions): Promise<boolean> {
  const events = await installedEvents(options);
  return events.length > 0;
}
