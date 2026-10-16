// settings.json is generated: global/settings.json merged with the machine
// file (machine wins, arrays concatenated). When Claude writes to the live
// file, drift detection finds what changed and proposes where it belongs.

import { readTextOrNull } from './files.js';
import {
  compareStrings,
  isArray,
  isRecord,
  jsonEqual,
  ownValue,
  setOwn,
  type JsonRecord,
  parseJson,
  stableJson,
} from './json.js';
import { LAYOUT, machineSettingsPath, repoFile } from './layout.js';

function concatUnique(base: readonly unknown[], extra: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const entry of [...base, ...extra]) {
    const key = stableJson(entry);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

function mergeRecords(base: JsonRecord, override: JsonRecord): JsonRecord {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the two walk each other
    setOwn(out, key, deepMerge(ownValue(base, key), value));
  }
  return out;
}

/** Merge `override` onto `base`: objects merge by key, arrays concatenate without duplicates, anything else is replaced. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return base;
  }
  if (isArray(base) && isArray(override)) {
    return concatUnique(base, override);
  }
  if (isRecord(base) && isRecord(override)) {
    return mergeRecords(base, override);
  }
  return override;
}

export function generateSettings(global: unknown, machine: unknown): JsonRecord {
  return mergeRecords(isRecord(global) ? global : {}, isRecord(machine) ? machine : {});
}

export interface GeneratedSettings {
  readonly settings: JsonRecord;
  /** The file content to write, with sorted keys. */
  readonly content: string;
  readonly globalFile: string;
  readonly machineFile: string;
}

async function readJsonFile(file: string): Promise<unknown> {
  const text = await readTextOrNull(file);
  if (text === null) {
    return {};
  }
  const value = parseJson(text);
  if (value === undefined) {
    throw new Error(`${file} is not valid JSON`);
  }
  return value;
}

/** Build settings.json from the repo's global and machine files. A missing file reads as {}. */
export async function generateSettingsFromRepo(
  repoRoot: string,
  host: string,
  globalSettings = LAYOUT.globalSettings,
): Promise<GeneratedSettings> {
  const globalFile = repoFile(repoRoot, globalSettings);
  const machineFile = repoFile(repoRoot, machineSettingsPath(host));
  const settings = generateSettings(
    await readJsonFile(globalFile),
    await readJsonFile(machineFile),
  );
  return { settings, content: stableJson(settings), globalFile, machineFile };
}

export type DriftEntry =
  | {
      readonly kind: 'added' | 'removed' | 'changed';
      readonly path: readonly string[];
      readonly current: unknown;
      readonly generated: unknown;
    }
  | {
      readonly kind: 'array';
      readonly path: readonly string[];
      readonly added: readonly unknown[];
      readonly removed: readonly unknown[];
    };

function without(list: readonly unknown[], other: readonly unknown[]): unknown[] {
  const keys = new Set(other.map((entry) => stableJson(entry)));
  return list.filter((entry) => !keys.has(stableJson(entry)));
}

function diffValue(keyPath: readonly string[], current: unknown, generated: unknown): DriftEntry[] {
  if (isRecord(current) && isRecord(generated)) {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the two walk each other
    return diffRecords(keyPath, current, generated);
  }
  if (isArray(current) && isArray(generated)) {
    const added = without(current, generated);
    const removed = without(generated, current);
    const same = added.length === 0 && removed.length === 0;
    return same ? [] : [{ kind: 'array', path: keyPath, added, removed }];
  }
  return jsonEqual(current, generated)
    ? []
    : [{ kind: 'changed', path: keyPath, current, generated }];
}

function diffRecords(
  keyPath: readonly string[],
  current: JsonRecord,
  generated: JsonRecord,
): DriftEntry[] {
  const keys = [...new Set([...Object.keys(current), ...Object.keys(generated)])].toSorted(
    compareStrings,
  );
  return keys.flatMap((key): DriftEntry[] => {
    const here = [...keyPath, key];
    if (!Object.hasOwn(generated, key)) {
      return [{ kind: 'added', path: here, current: ownValue(current, key), generated: undefined }];
    }
    if (!Object.hasOwn(current, key)) {
      return [
        { kind: 'removed', path: here, current: undefined, generated: ownValue(generated, key) },
      ];
    }
    return diffValue(here, ownValue(current, key), ownValue(generated, key));
  });
}

/** What differs between the live settings.json and the one the repo would generate. */
export function detectDrift(current: unknown, generated: unknown): readonly DriftEntry[] {
  return diffRecords([], isRecord(current) ? current : {}, isRecord(generated) ? generated : {});
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

function mentionsHome(value: unknown, home: string): boolean {
  const text = value === undefined ? '' : JSON.stringify(value);
  return text.includes(home) || /\/(?:Users|home)\/[^/"]+/u.test(text);
}

export interface DriftSplit {
  readonly toGlobal: readonly DriftEntry[];
  readonly toMachine: readonly DriftEntry[];
}

/**
 * Propose where each change belongs. A key the machine file already sets goes
 * back there, and so does a value with a home directory path in it, since
 * paths differ per machine. Everything else is shared.
 */
export function splitDrift(
  drift: readonly DriftEntry[],
  machine: unknown,
  home: string,
): DriftSplit {
  const toGlobal: DriftEntry[] = [];
  const toMachine: DriftEntry[] = [];
  for (const entry of drift) {
    const value = entry.kind === 'array' ? entry.added : entry.current;
    const local = valueAt(machine, entry.path) !== undefined || mentionsHome(value, home);
    (local ? toMachine : toGlobal).push(entry);
  }
  return { toGlobal, toMachine };
}

function setAt(root: Record<string, unknown>, keyPath: readonly string[], value: unknown): void {
  let node = root;
  for (const [index, key] of keyPath.entries()) {
    if (index < keyPath.length - 1) {
      const next = ownValue(node, key);
      const child: Record<string, unknown> = isRecord(next) ? { ...next } : {};
      setOwn(node, key, child);
      node = child;
    } else if (value === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing a settings key by path
      delete node[key];
    } else {
      setOwn(node, key, value);
    }
  }
}

/** Apply drift entries to a settings object (the global or the machine file), returning a new object. */
export function applyDrift(target: unknown, entries: readonly DriftEntry[]): JsonRecord {
  const out: Record<string, unknown> = isRecord(target) ? { ...target } : {};
  for (const entry of entries) {
    if (entry.kind === 'array') {
      const existing = valueAt(out, entry.path);
      const list = isArray(existing) ? existing : [];
      setAt(out, entry.path, concatUnique(without(list, entry.removed), entry.added));
    } else {
      setAt(out, entry.path, entry.current);
    }
  }
  return out;
}
