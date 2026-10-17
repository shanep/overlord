// The check toml-edit.ts runs after every edit: flatten the parsed file before
// and after into dotted keys and make sure only the keys the edit meant to
// touch differ.

import { isArray } from './json.js';
import { formatTomlKey, startsWith } from './toml-scan.js';

export interface Expectation {
  /** Keys at or under these paths may go away, and must be gone unless `set` puts them back. */
  readonly cleared: readonly (readonly string[])[];
  /** Keys that must hold exactly these values afterwards. */
  readonly set: readonly { readonly path: readonly string[]; readonly value: unknown }[];
  /** Tables along these paths may appear or vanish as empty tables. */
  readonly loose: readonly (readonly string[])[];
}

interface Leaf {
  readonly path: readonly string[];
  /** A canonical JSON form, so equal TOML values compare equal as strings. */
  readonly value: string;
}

const EMPTY_TABLE = '{}';

function isTable(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !isArray(value) && !(value instanceof Date);
}

/** Dates, NaN and the infinities do not survive JSON.stringify, so tag them first. */
function canonical(value: unknown): unknown {
  if (value instanceof Date) {
    return { date: value.toISOString() };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { number: String(value) };
  }
  if (isArray(value)) {
    return value.map((item) => canonical(item));
  }
  if (isTable(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function canonicalText(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function flattenInto(prefix: readonly string[], value: unknown, out: Map<string, Leaf>): void {
  if (isTable(value) && Object.keys(value).length > 0) {
    for (const [key, item] of Object.entries(value)) {
      flattenInto([...prefix, key], item, out);
    }
    return;
  }
  if (prefix.length > 0) {
    out.set(JSON.stringify(prefix), { path: prefix, value: canonicalText(value) });
  }
}

function flatten(data: unknown): ReadonlyMap<string, Leaf> {
  const out = new Map<string, Leaf>();
  flattenInto([], data, out);
  return out;
}

function underAny(path: readonly string[], prefixes: readonly (readonly string[])[]): boolean {
  return prefixes.some((prefix) => startsWith(path, prefix));
}

/** An empty table on the way to an edited key, which an edit may create or fill. */
function looseTable(leaf: Leaf, expect: Expectation): boolean {
  return leaf.value === EMPTY_TABLE && expect.loose.some((path) => startsWith(path, leaf.path));
}

function checkSet(after: ReadonlyMap<string, Leaf>, expect: Expectation): string | null {
  for (const item of expect.set) {
    const leaf = after.get(JSON.stringify(item.path));
    if (leaf?.value !== canonicalText(item.value)) {
      return `${formatTomlKey(item.path)} did not end up with the new value.`;
    }
  }
  return null;
}

function isSetPath(leaf: Leaf, expect: Expectation): boolean {
  return expect.set.some((item) => JSON.stringify(item.path) === JSON.stringify(leaf.path));
}

function checkAfter(
  before: ReadonlyMap<string, Leaf>,
  after: ReadonlyMap<string, Leaf>,
  expect: Expectation,
): string | null {
  for (const [id, leaf] of after) {
    if (isSetPath(leaf, expect) || looseTable(leaf, expect)) {
      continue;
    }
    if (underAny(leaf.path, expect.cleared)) {
      return `${formatTomlKey(leaf.path)} is still there.`;
    }
    if (before.get(id)?.value !== leaf.value) {
      return `${formatTomlKey(leaf.path)} would change too.`;
    }
  }
  return null;
}

function checkBefore(
  before: ReadonlyMap<string, Leaf>,
  after: ReadonlyMap<string, Leaf>,
  expect: Expectation,
): string | null {
  for (const [id, leaf] of before) {
    if (!after.has(id) && !underAny(leaf.path, expect.cleared) && !looseTable(leaf, expect)) {
      return `${formatTomlKey(leaf.path)} would be lost.`;
    }
  }
  return null;
}

/** Null when `after` differs from `before` only as `expect` allows, or what else moved. */
export function verifyEdit(before: unknown, after: unknown, expect: Expectation): string | null {
  const old = flatten(before);
  const next = flatten(after);
  return checkSet(next, expect) ?? checkAfter(old, next, expect) ?? checkBefore(old, next, expect);
}
