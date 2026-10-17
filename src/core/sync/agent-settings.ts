// An agent's settings file synced key by key. The config repo keeps the keys
// as JSON (agents/<id>/<repoName> plus a machine file), and applying them sets
// each key in the live file on its own. A TOML file such as Codex's
// config.toml only ever gets line level edits through knobs/toml-edit.ts, so
// its comments and section order stay. Nothing is ever removed from the live
// file and the whole file is never copied over.

import { parse } from 'smol-toml';

import type { SyncSettings } from '../agents/types.js';
import { readOptional, resolveLinkTarget, writeFileAtomic } from '../knobs/atomic-file.js';
import type { JsonValue } from '../knobs/json.js';
import {
  applyTomlEdit,
  editTomlFile,
  type TomlEdit,
  type TomlEditValue,
} from '../knobs/toml-edit.js';
import { setKeyPath } from '../knobs/write.js';

import { isDeniedSettingPath } from './denylist.js';
import { compareStrings, isArray, isRecord, jsonEqual, ownValue, setOwn } from './json.js';

/** One synced key and its value. */
export interface SettingEntry {
  readonly path: readonly string[];
  readonly value: JsonValue;
}

export type SettingsRead =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Copilot's JSON files start with line comments, which JSON.parse refuses. */
function withoutLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** The line comments at the top of a JSON file, kept when the file is written again. */
function leadingComments(text: string): string {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('//')) {
      break;
    }
    lines.push(line);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function parseSettings(text: string, format: SyncSettings['format']): SettingsRead {
  if (text.trim() === '') {
    return { ok: true, value: {} };
  }
  try {
    const value: unknown = format === 'toml' ? parse(text) : JSON.parse(withoutLineComments(text));
    return isRecord(value) ? { ok: true, value } : { ok: false, error: 'it is not an object' };
  } catch (error: unknown) {
    return { ok: false, error: messageOf(error) };
  }
}

/** The live settings file, read as an object. A missing file reads as {}. */
export async function readSettings(
  file: string,
  format: SyncSettings['format'],
): Promise<SettingsRead> {
  const text = await readOptional(file);
  return text === null ? { ok: true, value: {} } : parseSettings(text, format);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** A value plain JSON can hold. TOML dates and anything else are left out. */
// A JSON value is a union of scalars, lists and objects, so its converter returns each of them.
// eslint-disable-next-line sonarjs/function-return-type
function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || isScalar(value)) {
    return value;
  }
  if (isArray(value)) {
    const items = value.map((item) => toJsonValue(item));
    return items.every((item) => item !== undefined) ? items : undefined;
  }
  if (isRecord(value) && !(value instanceof Date)) {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const item = toJsonValue(value[key]);
      if (item === undefined) {
        return undefined;
      }
      setOwn(out, key, item);
    }
    return out;
  }
  return undefined;
}

/** What the TOML editor can write: a scalar or a flat list of scalars. */
function fitsToml(value: JsonValue): value is JsonValue & TomlEditValue {
  return isScalar(value) || (isArray(value) && value.every((item) => isScalar(item)));
}

/**
 * Every leaf key of a settings object, in key order. Objects are walked and
 * lists are leaves. For TOML, a leaf the line editor cannot write (a list of
 * tables, a date) is left out.
 */
export function settingEntries(
  value: unknown,
  format: SyncSettings['format'],
  prefix: readonly string[] = [],
): SettingEntry[] {
  if (!isRecord(value) || value instanceof Date) {
    return [];
  }
  return Object.keys(value)
    .toSorted(compareStrings)
    .flatMap((key): SettingEntry[] => {
      const child = ownValue(value, key);
      const here = [...prefix, key];
      if (isRecord(child) && !(child instanceof Date)) {
        return settingEntries(child, format, here);
      }
      const json = toJsonValue(child);
      if (json === undefined || (format === 'toml' && !fitsToml(json))) {
        return [];
      }
      return [{ path: here, value: json }];
    });
}

/** The keys worth syncing: never a denied key, and never one the agent keeps per machine. */
export function entriesToSync(value: unknown, spec: SyncSettings): SettingEntry[] {
  return settingEntries(value, spec.format).filter(
    (entry) => !isDeniedSettingPath(entry.path) && !spec.local(entry.path),
  );
}

function valueAt(root: unknown, keyPath: readonly string[]): unknown {
  let node = root;
  for (const key of keyPath) {
    if (!isRecord(node)) {
      return undefined;
    }
    node = ownValue(node, key);
  }
  return node;
}

/** The entries whose value differs from the live file's, which are the ones to set. */
export function changedEntries(wanted: readonly SettingEntry[], live: unknown): SettingEntry[] {
  return wanted.filter((entry) => !jsonEqual(toJsonValue(valueAt(live, entry.path)), entry.value));
}

/** Entries back into a nested object, for the repo copy. */
export function entriesToObject(entries: readonly SettingEntry[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    let node = out;
    for (const [index, key] of entry.path.entries()) {
      if (index === entry.path.length - 1) {
        setOwn(node, key, entry.value);
      } else {
        const next = ownValue(node, key);
        const child: Record<string, unknown> = isRecord(next) ? { ...next } : {};
        setOwn(node, key, child);
        node = child;
      }
    }
  }
  return out;
}

function editFor(entry: SettingEntry): TomlEdit | null {
  return fitsToml(entry.value) ? { op: 'set', path: entry.path, value: entry.value } : null;
}

async function setTomlKeys(file: string, entries: readonly SettingEntry[]): Promise<string[]> {
  const target = await resolveLinkTarget(file);
  let text = (await readOptional(target)) ?? '';
  const edits: TomlEdit[] = [];
  const failed: string[] = [];
  // Try each key on its own first, so one key the editor refuses (say one
  // inside an inline table) does not hold back the rest.
  for (const entry of entries) {
    const edit = editFor(entry);
    const result = edit === null ? null : applyTomlEdit(text, edit);
    if (edit !== null && result?.ok === true) {
      text = result.text;
      edits.push(edit);
    } else {
      const why = result?.ok === false ? result.error : 'the value cannot be written to TOML';
      failed.push(`${entry.path.join('.')}: ${why}`);
    }
  }
  if (edits.length > 0) {
    const written = await editTomlFile(target, edits);
    if (!written.ok) {
      return [written.error];
    }
  }
  return failed;
}

async function setJsonKeys(file: string, entries: readonly SettingEntry[]): Promise<string[]> {
  const target = await resolveLinkTarget(file);
  const existing = await readOptional(target);
  const read = parseSettings(existing ?? '', 'json');
  if (!read.ok) {
    return [`${target} is not valid JSON (${read.error}), so it was left alone`];
  }
  let document = read.value;
  const failed: string[] = [];
  for (const entry of entries) {
    const updated = setKeyPath(document, entry.path, entry.value);
    if (updated.ok) {
      document = updated.value;
    } else {
      failed.push(`${entry.path.join('.')}: ${updated.error}`);
    }
  }
  const content = `${leadingComments(existing ?? '')}${JSON.stringify(document, null, 2)}\n`;
  if (content !== existing) {
    await writeFileAtomic({ target, content, backup: null });
  }
  return failed;
}

/** Set each key in the live file, leaving every other key alone. Returns the keys that could not be set. */
export async function setSettingKeys(
  file: string,
  format: SyncSettings['format'],
  entries: readonly SettingEntry[],
): Promise<readonly string[]> {
  return format === 'toml' ? setTomlKeys(file, entries) : setJsonKeys(file, entries);
}
