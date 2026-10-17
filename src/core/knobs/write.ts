// Safe edits to one key of a settings file: other keys and their order
// stay as they were, the old file is kept as <file>.bak, and the write is
// atomic. A file that does not parse is never touched. TOML files go through
// the line-level editor in toml-edit.ts so their comments survive. A JSONC
// file keeps the comments at its top, and one with comments further down is
// left alone, since writing it again from parsed JSON would drop them.

import { readOptional, resolveLinkTarget, writeFileAtomic } from './atomic-file.js';
import {
  errorMessage,
  isArray,
  isPlainObject,
  parseJson,
  type JsonRecord,
  type JsonValue,
} from './json.js';
import { parseJsonc, splitHeader } from './jsonc.js';
import { editTomlFile, parseTomlKey, type TomlEditValue } from './toml-edit.js';

export interface WriteSettingInput {
  readonly file: string;
  /** Dotted path such as "permissions.defaultMode". */
  readonly keyPath: string;
  /** The new value, or undefined to delete the key. */
  readonly value: JsonValue | undefined;
  /** How the file is written. JSON when left out. */
  readonly format?: 'json' | 'jsonc' | 'toml' | undefined;
}

export type WriteSettingResult =
  | {
      readonly ok: true;
      /** The file actually written, after following symlinks. */
      readonly file: string;
      readonly changed: boolean;
      /** The backup of the previous content, or null when there was no previous file. */
      readonly backup: string | null;
    }
  | { readonly ok: false; readonly error: string };

type PathResult =
  | { readonly ok: true; readonly value: JsonRecord }
  | { readonly ok: false; readonly error: string };

function withKey(target: JsonRecord, key: string, value: unknown): JsonRecord {
  const entries = Object.entries(target);
  const replaced: (readonly [string, unknown])[] = Object.hasOwn(target, key)
    ? entries.map(([name, old]): [string, unknown] => [name, name === key ? value : old])
    : [...entries, [key, value]];
  return Object.fromEntries(replaced);
}

function withoutKey(target: JsonRecord, key: string): JsonRecord {
  return Object.fromEntries(Object.entries(target).filter(([name]) => name !== key));
}

function childOf(target: JsonRecord, key: string): unknown {
  return Object.hasOwn(target, key) ? target[key] : undefined;
}

/** Set or delete a nested key, building new objects (never mutating, never touching prototypes). */
export function setKeyPath(
  target: JsonRecord,
  segments: readonly string[],
  value: JsonValue | undefined,
): PathResult {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return { ok: false, error: 'The key path is empty.' };
  }
  if (rest.length === 0) {
    return {
      ok: true,
      value: value === undefined ? withoutKey(target, head) : withKey(target, head, value),
    };
  }
  const child = childOf(target, head);
  if (child === undefined && value === undefined) {
    return { ok: true, value: target };
  }
  const base = child ?? {};
  if (!isPlainObject(base)) {
    return {
      ok: false,
      error: `${head} holds a ${Array.isArray(base) ? 'list' : typeof base}, not an object.`,
    };
  }
  const inner = setKeyPath(base, rest, value);
  return inner.ok ? { ok: true, value: withKey(target, head, inner.value) } : inner;
}

/** Serialize the way Claude Code writes settings: 2-space indent and a trailing newline. */
export function formatSettings(values: JsonRecord): string {
  return `${JSON.stringify(values, null, 2)}\n`;
}

function readDocument(file: string, text: string | null): PathResult {
  if (text === null || text.trim() === '') {
    return { ok: true, value: {} };
  }
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `${file} is not valid JSON (${parsed.error}), so it was left alone.`,
    };
  }
  return isPlainObject(parsed.value)
    ? { ok: true, value: parsed.value }
    : { ok: false, error: `${file} does not hold a JSON object, so it was left alone.` };
}

/** The JSON part of a file and the comment lines kept above it. JSONC files keep their top comments. */
function readBody(
  file: string,
  text: string | null,
  jsonc: boolean,
): { readonly header: string; readonly document: PathResult } {
  if (!jsonc || text === null) {
    return { header: '', document: readDocument(file, text) };
  }
  const { header, body } = splitHeader(text);
  const document = readDocument(file, body);
  if (!document.ok && parseJsonc(body).ok) {
    return {
      header,
      document: {
        ok: false,
        error: `${file} has comments or trailing commas below its first lines, so it was left alone to keep them.`,
      },
    };
  }
  return { header, document };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** True for what the TOML editor can write: no tables and no nested lists. */
function isTomlValue(value: JsonValue): value is JsonValue & TomlEditValue {
  return isScalar(value) || (isArray(value) && value.every((item) => isScalar(item)));
}

async function writeTomlSetting(input: WriteSettingInput): Promise<WriteSettingResult> {
  const path = parseTomlKey(input.keyPath);
  if (path === null) {
    return { ok: false, error: `Invalid key path "${input.keyPath}".` };
  }
  if (input.value === undefined) {
    return editTomlFile(input.file, { op: 'remove', path });
  }
  return isTomlValue(input.value)
    ? editTomlFile(input.file, { op: 'set', path, value: input.value })
    : {
        ok: false,
        error: `${input.keyPath} needs a string, number, true or false, or a list of those.`,
      };
}

export async function writeSetting(input: WriteSettingInput): Promise<WriteSettingResult> {
  if (input.format === 'toml') {
    return writeTomlSetting(input);
  }
  const segments = input.keyPath.split('.');
  if (segments.includes('')) {
    return { ok: false, error: `Invalid key path "${input.keyPath}".` };
  }
  try {
    const target = await resolveLinkTarget(input.file);
    const existing = await readOptional(target);
    const { header, document } = readBody(target, existing, input.format === 'jsonc');
    if (!document.ok) {
      return document;
    }
    const updated = setKeyPath(document.value, segments, input.value);
    if (!updated.ok) {
      return { ok: false, error: `Cannot set ${input.keyPath}: ${updated.error}` };
    }
    const content = `${header}${formatSettings(updated.value)}`;
    const unchanged = existing === null ? input.value === undefined : content === existing;
    if (unchanged) {
      return { ok: true, file: target, changed: false, backup: null };
    }
    const backup = existing === null ? null : `${target}.bak`;
    await writeFileAtomic({ target, content, backup });
    return { ok: true, file: target, changed: true, backup };
  } catch (error) {
    return { ok: false, error: `Cannot write ${input.file}: ${errorMessage(error)}` };
  }
}
