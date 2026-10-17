// Copilot CLI's hooks behind the hooks facet. Overlord owns one file,
// $COPILOT_HOME/hooks/overlord.json (default ~/.copilot/hooks), and never
// touches the user's other hook files. User level is the one place that
// fired in 1.0.89: a repo's .github/hooks/*.json did not fire in -p mode.
//
// What a command hook can say back, from the 1.0.89 hooks reference:
// - sessionStart, postToolUse and postToolUseFailure take additionalContext.
// - preToolUse takes permissionDecision deny, so an edit conflict blocks.
// - permissionRequest takes behavior allow or deny, with message and interrupt.
// - userPromptSubmitted output is dropped, so a note for it waits for the
//   next event that carries context (see NoteCarry).
// Copilot shows nothing from a hook to the user, so notices are dropped.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { COPILOT } from '../../../shared/agents.js';
import type { PermissionDecision } from '../../../shared/model.js';
import { EVENT_TIMEOUT_S, HOOK_MARKER } from '../../hooks/install.js';
import type {
  EditTools,
  HookAnswer,
  HookEventBase,
  HookNormalizeResult,
  HookToolCall,
  NormalizedHookEvent,
  RawHook,
  SessionStartSource,
} from '../../hooks/normalized.js';
import type { HookOutput } from '../../hooks/protocol.js';
import type { AgentDirs, HooksFacet, ShellEnv } from '../types.js';

import { copilotHome } from './observer.js';

/** The file Overlord writes in Copilot's hooks folder. Its name is how it is found again. */
const HOOKS_FILE = 'overlord.json';

/** The events Overlord listens to. These are the ones the 1.0.89 recordings fired. */
export const COPILOT_HOOK_EVENTS: readonly string[] = [
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'permissionRequest',
  'agentStop',
  'notification',
];

/** Events whose additionalContext reaches the model. */
const CONTEXT_EVENTS: ReadonlySet<string> = new Set([
  'sessionStart',
  'postToolUse',
  'postToolUseFailure',
]);

/**
 * Copilot's file tools and their path field. str_replace_editor is left out
 * because its view command reads, and apply_patch keeps its paths inside the
 * patch text, so neither has a field that names a written file.
 */
const EDIT_TOOLS: EditTools = {
  edit: ['path'],
  create: ['path'],
};

/** Copilot says new for a fresh session. startup is in the SDK types too. */
const SOURCES: ReadonlyMap<string, SessionStartSource> = new Map([
  ['new', 'new'],
  ['startup', 'new'],
  ['resume', 'resume'],
]);

/** The dirs for Copilot's facets: COPILOT_HOME when set, else ~/.copilot. */
export function copilotDirs(home: string, env: ShellEnv): AgentDirs {
  return { home, configDir: copilotHome({ home, env }) };
}

export function hooksFile(dirs: AgentDirs): string {
  return path.join(dirs.configDir, 'hooks', HOOKS_FILE);
}

// The payloads, as Copilot 1.0.89 wrote them to a hook's stdin. Every one has
// sessionId, cwd and an epoch millisecond timestamp, and none names its event.
const baseSchema = z.looseObject({
  sessionId: z.string().min(1),
  cwd: z.string().optional(),
  timestamp: z.number().optional(),
  transcriptPath: z.string().optional(),
});
const toolSchema = z.looseObject({ toolName: z.string(), toolArgs: z.unknown() });

type Base = z.infer<typeof baseSchema>;
type Converter = (payload: unknown, base: HookEventBase) => NormalizedHookEvent | null;

function parsed<S extends z.ZodType>(
  schema: S,
  payload: unknown,
  build: (value: z.infer<S>) => NormalizedHookEvent,
): NormalizedHookEvent | null {
  const result = schema.safeParse(payload);
  return result.success ? build(result.data) : null;
}

function toolCall(name: string, input: unknown): HookToolCall {
  // Copilot's hooks carry no id for the call.
  return { name, input, useId: null };
}

const CONVERTERS: Readonly<Record<string, Converter>> = {
  sessionStart: (payload, base) =>
    parsed(z.looseObject({ source: z.string() }), payload, (value) => ({
      ...base,
      kind: 'session-start',
      source: SOURCES.get(value.source) ?? 'other',
      model: null,
      title: null,
    })),
  // Over ACP Copilot sends sessionEnd with reason complete after every
  // prompt, so complete only ends the turn. The other reasons end the session.
  sessionEnd: (payload, base) =>
    parsed(
      z.looseObject({ reason: z.string(), finalMessage: z.string().optional() }),
      payload,
      (value) =>
        value.reason === 'complete'
          ? { ...base, kind: 'stop', lastMessage: value.finalMessage ?? null }
          : { ...base, kind: 'session-end', reason: value.reason },
    ),
  userPromptSubmitted: (payload, base) =>
    parsed(z.looseObject({ prompt: z.string() }), payload, (value) => ({
      ...base,
      kind: 'prompt-submit',
      prompt: value.prompt,
      title: null,
    })),
  preToolUse: (payload, base) =>
    parsed(toolSchema, payload, (value) => ({
      ...base,
      kind: 'pre-tool-use',
      tool: toolCall(value.toolName, value.toolArgs),
    })),
  postToolUse: (payload, base) =>
    parsed(toolSchema.extend({ toolResult: z.unknown() }), payload, (value) => ({
      ...base,
      kind: 'post-tool-use',
      tool: toolCall(value.toolName, value.toolArgs),
      response: value.toolResult,
    })),
  postToolUseFailure: (payload, base) =>
    parsed(toolSchema.extend({ error: z.string() }), payload, (value) => ({
      ...base,
      kind: 'tool-failed',
      tool: toolCall(value.toolName, value.toolArgs),
      error: value.error,
    })),
  permissionRequest: (payload, base) =>
    parsed(z.looseObject({ toolName: z.string(), toolInput: z.unknown() }), payload, (value) => ({
      ...base,
      kind: 'permission-request',
      tool: toolCall(value.toolName, value.toolInput),
    })),
  agentStop: (_payload, base) => ({ ...base, kind: 'stop', lastMessage: null }),
  notification: (payload, base) =>
    parsed(
      z.looseObject({ message: z.string(), title: z.string().optional() }),
      payload,
      (value) => ({
        ...base,
        kind: 'notification',
        message: value.message,
        title: value.title ?? null,
      }),
    ),
};

/** The event's name: the relay's --event flag, else the hookName a permissionRequest payload has. */
function eventName(raw: RawHook): string {
  if (raw.name !== null && raw.name !== '') {
    return raw.name;
  }
  const named = z.looseObject({ hookName: z.string() }).safeParse(raw.payload);
  return named.success ? named.data.hookName : '';
}

function baseOf(native: string, value: Base): HookEventBase {
  return {
    agent: COPILOT,
    native,
    sessionId: value.sessionId,
    // Copilot's hook payloads do not say which subagent a hook fired in.
    subagentId: null,
    cwd: value.cwd ?? null,
    transcriptPath: value.transcriptPath ?? null,
    timestamp: value.timestamp ?? null,
  };
}

/** Reads a Copilot hook's stdin. The event name comes from the relay's --event flag. */
export function normalizeCopilotHook(raw: RawHook): HookNormalizeResult {
  const base = baseSchema.safeParse(raw.payload);
  if (!base.success) {
    return { ok: false, error: 'a Copilot hook payload needs a sessionId' };
  }
  const native = eventName(raw);
  const common = baseOf(native, base.data);
  const convert = Object.hasOwn(CONVERTERS, native) ? CONVERTERS[native] : undefined;
  const event = convert?.(raw.payload, common) ?? null;
  return { ok: true, event: event ?? { ...common, kind: 'other' } };
}

/** Most sessions whose notes wait at once. The oldest is dropped past it. */
const MAX_CARRIED = 200;

/**
 * Notes for an event whose output Copilot drops, kept per session until an
 * event that carries context comes along. A new session's first prompt fires
 * before its sessionStart, so those notes go out a moment later.
 */
export class NoteCarry {
  private readonly notes = new Map<string, string[]>();

  add(sessionId: string, text: string): void {
    const held = this.notes.get(sessionId) ?? [];
    this.notes.delete(sessionId);
    this.notes.set(sessionId, held.includes(text) ? held : [...held, text]);
    for (const oldest of this.notes.keys()) {
      if (this.notes.size <= MAX_CARRIED) {
        break;
      }
      this.notes.delete(oldest);
    }
  }

  /** The notes held for a session, oldest first, which are then forgotten. */
  take(sessionId: string): readonly string[] {
    const held = this.notes.get(sessionId) ?? [];
    this.notes.delete(sessionId);
    return held;
  }
}

function decisionOutput(decision: PermissionDecision): HookOutput {
  if (decision.behavior === 'allow') {
    return { behavior: 'allow' };
  }
  return {
    behavior: 'deny',
    message: decision.message,
    ...(decision.interrupt === true ? { interrupt: true } : {}),
  };
}

/** The JSON a Copilot hook prints, with notes for events that cannot carry them held in carry. */
export function answerCopilotHook(
  carry: NoteCarry,
  event: NormalizedHookEvent,
  answer: HookAnswer,
): HookOutput {
  if (answer.decision !== undefined) {
    return decisionOutput(answer.decision);
  }
  const context = answer.context ?? '';
  if (!CONTEXT_EVENTS.has(event.native)) {
    if (context !== '') {
      carry.add(event.sessionId, context);
    }
    return answer.block === undefined
      ? {}
      : { permissionDecision: 'deny', permissionDecisionReason: answer.block };
  }
  const notes = [...carry.take(event.sessionId)];
  if (context !== '' && !notes.includes(context)) {
    notes.push(context);
  }
  return notes.length === 0 ? {} : { additionalContext: notes.join('\n\n') };
}

const handlerSchema = z.looseObject({
  bash: z.string().optional(),
  powershell: z.string().optional(),
  command: z.string().optional(),
});
const fileSchema = z.looseObject({
  hooks: z.record(z.string(), z.array(handlerSchema)),
});

/** The hooks file Overlord would write for this command. */
function hooksFileText(command: string): string {
  if (!command.includes(HOOK_MARKER)) {
    throw new Error(`the hook command must contain "${HOOK_MARKER}"`);
  }
  const hooks: Record<string, unknown[]> = {};
  for (const event of COPILOT_HOOK_EVENTS) {
    const line = `${command} --agent ${COPILOT} --event ${event}`;
    // Overlord answers every event at once, permissionRequest included, so
    // the short timeout fits them all. A timed out hook fails open.
    hooks[event] = [{ type: 'command', bash: line, powershell: line, timeoutSec: EVENT_TIMEOUT_S }];
  }
  return `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** True when the text is a hooks file with an Overlord command in it. */
function isOurs(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  const result = fileSchema.safeParse(value);
  if (!result.success) {
    return false;
  }
  return Object.values(result.data.hooks).some((handlers) =>
    handlers.some((handler) =>
      [handler.bash, handler.powershell, handler.command].some(
        (line) => line?.includes(HOOK_MARKER) ?? false,
      ),
    ),
  );
}

async function install(dirs: AgentDirs, command: string): Promise<{ readonly changed: boolean }> {
  const file = hooksFile(dirs);
  const next = hooksFileText(command);
  if ((await readText(file)) === next) {
    return { changed: false };
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.overlord-${String(process.pid)}-${String(Date.now())}.tmp`;
  try {
    await writeFile(temporary, next, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { changed: true };
}

async function uninstall(dirs: AgentDirs): Promise<{ readonly changed: boolean }> {
  const file = hooksFile(dirs);
  const text = await readText(file);
  // A file of this name without Overlord's command is someone else's, so it stays.
  if (text === null || !isOurs(text)) {
    return { changed: false };
  }
  await rm(file, { force: true });
  return { changed: true };
}

async function installed(dirs: AgentDirs): Promise<boolean> {
  const text = await readText(hooksFile(dirs));
  return text !== null && isOurs(text);
}

/** A hooks facet with its own note carry, so tests do not share one. */
export function createCopilotHooks(): HooksFacet {
  const carry = new NoteCarry();
  return {
    install,
    uninstall,
    installed,
    normalize: normalizeCopilotHook,
    answer: (event, answer) => answerCopilotHook(carry, event, answer),
    editTools: EDIT_TOOLS,
    // The permissionRequest hook fires before Copilot's own rules, so it runs
    // for calls Copilot would allow by itself (run 05 in the fixtures). It
    // must not wait on the inbox. Copilot asks in its own prompt, and a
    // Launcher run's ACP request reaches the inbox.
    holdsPermissions: false,
  };
}

export const copilotHooks: HooksFacet = createCopilotHooks();
