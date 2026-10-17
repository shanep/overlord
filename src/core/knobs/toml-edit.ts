// Targeted edits to a TOML file such as ~/.codex/config.toml. People keep
// comments and section order in that file, and a parse and stringify round
// trip loses both, so an edit here changes only the lines of one key or one
// [section] and leaves every other byte alone. The result is parsed again and
// must differ from the original in the edited keys only, or nothing is written.

import { rm } from 'node:fs/promises';

import { parse, TomlError } from 'smol-toml';

import { readOptional, resolveLinkTarget, writeFileAtomic } from './atomic-file.js';
import { errorMessage, isArray } from './json.js';
import {
  formatTomlKey,
  formatTomlValue,
  pairPath,
  samePath,
  scanToml,
  startsWith,
  type TomlEditValue,
  type TomlHeader,
  type TomlPair,
  type TomlStatement,
} from './toml-scan.js';
import { verifyEdit, type Expectation } from './toml-verify.js';

export { formatTomlKey, formatTomlValue, parseTomlKey, type TomlEditValue } from './toml-scan.js';

export interface TomlEntry {
  readonly key: readonly string[];
  readonly value: TomlEditValue;
}

export type TomlEdit =
  /** Replace a key's value, or add the key to its table (a new [table] at the end when there is none). */
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: TomlEditValue }
  /** Remove a key's lines. A key that is not there is no change. */
  | { readonly op: 'remove'; readonly path: readonly string[] }
  /** Add a [table] block at the end of the file. Refused when the table already has keys. */
  | {
      readonly op: 'add-section';
      readonly table: readonly string[];
      readonly entries: readonly TomlEntry[];
    }
  /** Remove a [table] header and the keys under it. */
  | { readonly op: 'remove-section'; readonly table: readonly string[] };

export type TomlEditResult =
  | { readonly ok: true; readonly text: string; readonly changed: boolean }
  | { readonly ok: false; readonly error: string };

export type TomlFileResult =
  | {
      readonly ok: true;
      /** The file actually written, after following symlinks. */
      readonly file: string;
      readonly changed: boolean;
      /** The backup of the previous content, or null when there was no previous file. */
      readonly backup: string | null;
    }
  | { readonly ok: false; readonly error: string };

interface Source {
  readonly text: string;
  readonly data: unknown;
  readonly statements: readonly TomlStatement[];
  readonly eol: string;
}

interface Change {
  readonly text: string;
  readonly expect: Expectation;
}

type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

type Planned = Outcome<Change>;

const NOTHING: Expectation = { cleared: [], set: [], loose: [] };

function refuse(error: string): Planned {
  return { ok: false, error };
}

function planned(text: string, expect: Expectation): Planned {
  return { ok: true, value: { text, expect } };
}

function parseError(error: unknown): string {
  if (error instanceof TomlError) {
    const [first = error.message] = error.message.split('\n');
    return `${first} (line ${String(error.line)})`;
  }
  return errorMessage(error);
}

function readSource(text: string): Outcome<Source> {
  try {
    const data: unknown = parse(text);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return { ok: true, value: { text, data, statements: scanToml(text), eol } };
  } catch (error) {
    return { ok: false, error: `it is not valid TOML: ${parseError(error)}` };
  }
}

function headers(source: Source): readonly TomlHeader[] {
  return source.statements.filter((item): item is TomlHeader => item.kind === 'header');
}

function pairs(source: Source): readonly TomlPair[] {
  return source.statements.filter((item): item is TomlPair => item.kind === 'pair');
}

function isTable(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !isArray(value) && !(value instanceof Date);
}

/** The parsed value at a path, or undefined when nothing is there. */
function valueAt(data: unknown, path: readonly string[]): unknown {
  let current = data;
  for (const segment of path) {
    if (!isTable(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Why a path cannot be edited line by line, or null when it can. With `self`,
 * the path is a table to create, so the path itself must not hold a value either.
 */
function refusal(source: Source, path: readonly string[], self = false): string | null {
  const name = formatTomlKey(path);
  if (path.length === 0) {
    return self ? 'The table name is empty.' : 'The key is empty.';
  }
  const reach = self ? path.length + 1 : path.length;
  if (headers(source).some((header) => header.array && startsWith(path, header.path))) {
    return `${name} is inside an array of tables. Set it with -c or edit the file.`;
  }
  const holder = pairs(source).find((pair) => {
    const full = pairPath(pair);
    return full.length < reach && startsWith(path, full);
  });
  if (holder !== undefined) {
    return holder.inline
      ? `${name} is inside an inline table. Set it with -c or edit the file.`
      : `${formatTomlKey(pairPath(holder))} holds a value, not a table.`;
  }
  for (let length = 1; length < reach; length += 1) {
    const value = valueAt(source.data, path.slice(0, length));
    if (value !== undefined && !isTable(value)) {
      return `${formatTomlKey(path.slice(0, length))} holds a value, not a table.`;
    }
  }
  return null;
}

function eolBefore(text: string, offset: number): number {
  if (text.charAt(offset - 1) !== '\n') {
    return 0;
  }
  return text.charAt(offset - 2) === '\r' ? 2 : 1;
}

/** Insert whole lines at a line start. At the end of a file with no final newline, the file still ends without one. */
function insertLines(source: Source, offset: number, lines: readonly string[]): string {
  const { text, eol } = source;
  if (offset === text.length && text.length > 0 && !text.endsWith('\n')) {
    return `${text}${eol}${lines.join(eol)}`;
  }
  const added = lines.map((line) => `${line}${eol}`).join('');
  return `${text.slice(0, offset)}${added}${text.slice(offset)}`;
}

/** Cut [start, end). When that takes the last line of a file with no final newline, the newline before it goes too. */
function cut(text: string, start: number, end: number): string {
  const trim = end === text.length && !text.endsWith('\n') ? eolBefore(text, start) : 0;
  return `${text.slice(0, start - trim)}${text.slice(end)}`;
}

function lastLineBlank(text: string): boolean {
  const body = text.endsWith('\n')
    ? text.slice(0, text.length - eolBefore(text, text.length))
    : text;
  return body.slice(body.lastIndexOf('\n') + 1).trim() === '';
}

function appendSection(
  source: Source,
  table: readonly string[],
  entries: readonly TomlEntry[],
): string {
  const lines = [
    `[${formatTomlKey(table)}]`,
    ...entries.map((entry) => `${formatTomlKey(entry.key)} = ${formatTomlValue(entry.value)}`),
  ];
  if (source.text === '') {
    return `${lines.join(source.eol)}${source.eol}`;
  }
  return insertLines(
    source,
    source.text.length,
    lastLineBlank(source.text) ? lines : ['', ...lines],
  );
}

/** The statements of a table's block: after its header up to the next header. Root is the block before the first header. */
function block(source: Source, header: TomlHeader | null): readonly TomlStatement[] {
  const from = header === null ? 0 : source.statements.indexOf(header) + 1;
  const next = source.statements.findIndex(
    (item, index) => index >= from && item.kind === 'header',
  );
  return source.statements.slice(from, next === -1 ? undefined : next);
}

/** Where the comments right above the next header begin, so new lines do not land between them and it. */
function attachedStart(source: Source, next: TomlStatement | undefined): number {
  if (next === undefined) {
    return source.text.length;
  }
  let index = source.statements.indexOf(next);
  while (source.statements[index - 1]?.kind === 'comment') {
    index -= 1;
  }
  return source.statements[index]?.start ?? next.start;
}

function addToRoot(source: Source, line: string): string {
  const first = headers(source)[0];
  const offset = attachedStart(source, first);
  if (first === undefined) {
    return insertLines(source, offset, [line]);
  }
  // Keep a blank line between the new key and the table that follows.
  return insertLines(source, offset, [line, '']);
}

/** Add `key = value` after the last key of a block, with that key's indent. */
function addToBlock(source: Source, header: TomlHeader | null, entry: TomlEntry): string {
  const keys = block(source, header).filter((item): item is TomlPair => item.kind === 'pair');
  const last = keys.at(-1);
  const line = `${last?.indent ?? ''}${formatTomlKey(entry.key)} = ${formatTomlValue(entry.value)}`;
  if (last !== undefined) {
    return insertLines(source, last.end, [line]);
  }
  return header === null ? addToRoot(source, line) : insertLines(source, header.end, [line]);
}

function headerFor(source: Source, table: readonly string[]): TomlHeader | undefined {
  return headers(source).find((header) => !header.array && samePath(header.path, table));
}

function addKey(source: Source, path: readonly string[], value: TomlEditValue): string {
  const table = path.slice(0, -1);
  const key = path.slice(-1);
  if (table.length === 0) {
    return addToBlock(source, null, { key, value });
  }
  const header = headerFor(source, table);
  if (header !== undefined) {
    return addToBlock(source, header, { key, value });
  }
  // A table made by dotted keys (otel.exporter = ...) gets the new key next to its siblings.
  const sibling = pairs(source).findLast((pair) => startsWith(pairPath(pair), table));
  if (sibling !== undefined) {
    const line = `${sibling.indent}${formatTomlKey(path.slice(sibling.table.length))} = ${formatTomlValue(value)}`;
    return insertLines(source, sibling.end, [line]);
  }
  return appendSection(source, table, [{ key, value }]);
}

function findPair(source: Source, path: readonly string[]): TomlPair | undefined {
  return pairs(source).find((pair) => samePath(pairPath(pair), path));
}

function planSet(source: Source, path: readonly string[], value: TomlEditValue): Planned {
  const refused = refusal(source, path);
  if (refused !== null) {
    return refuse(refused);
  }
  const name = formatTomlKey(path);
  const existing = findPair(source, path);
  if (existing?.inline === true) {
    return refuse(`${name} is an inline table. Set it with -c or edit the file.`);
  }
  const old = valueAt(source.data, path);
  if (isTable(old) || (isArray(old) && old.some((item) => isTable(item)))) {
    return refuse(`${name} is a table, not a value.`);
  }
  const expect: Expectation = { cleared: [path], set: [{ path, value }], loose: [path] };
  if (existing === undefined) {
    return planned(addKey(source, path, value), expect);
  }
  const { text } = source;
  const before = text.slice(0, existing.valueStart);
  return planned(`${before}${formatTomlValue(value)}${text.slice(existing.valueEnd)}`, expect);
}

function planRemove(source: Source, path: readonly string[]): Planned {
  const refused = refusal(source, path);
  if (refused !== null) {
    return refuse(refused);
  }
  const existing = findPair(source, path);
  if (existing === undefined) {
    return isTable(valueAt(source.data, path))
      ? refuse(`${formatTomlKey(path)} is a table. Remove its section instead.`)
      : planned(source.text, NOTHING);
  }
  const text = cut(source.text, existing.start, existing.end);
  return planned(text, { cleared: [path], set: [], loose: [path] });
}

function planAddSection(
  source: Source,
  table: readonly string[],
  entries: readonly TomlEntry[],
): Planned {
  const refused = refusal(source, table, true);
  if (refused !== null) {
    return refuse(refused);
  }
  const name = formatTomlKey(table);
  const taken =
    headerFor(source, table) !== undefined ||
    pairs(source).some(
      (pair) => pair.table.length <= table.length && startsWith(pairPath(pair), table),
    );
  if (taken) {
    return refuse(`[${name}] already exists. Set its keys one at a time instead.`);
  }
  const set = entries.map((entry) => ({ path: [...table, ...entry.key], value: entry.value }));
  return planned(appendSection(source, table, entries), { cleared: [], set, loose: [table] });
}

function planRemoveSection(source: Source, table: readonly string[]): Planned {
  const header = headerFor(source, table);
  if (header === undefined) {
    return headers(source).some((item) => samePath(item.path, table))
      ? refuse(`[[${formatTomlKey(table)}]] is an array of tables. Edit the file to change it.`)
      : planned(source.text, NOTHING);
  }
  const index = source.statements.indexOf(header);
  const next = source.statements.slice(index + 1).find((item) => item.kind === 'header');
  let start = header.start;
  const end = attachedStart(source, next);
  if (next === undefined) {
    // The last section: drop the blank lines above it too, so the file does not end in blanks.
    for (let before = index - 1; source.statements[before]?.kind === 'blank'; before -= 1) {
      start = source.statements[before]?.start ?? start;
    }
  }
  const cleared = block(source, header)
    .filter((item): item is TomlPair => item.kind === 'pair')
    .map((pair) => pairPath(pair));
  return planned(cut(source.text, start, end), { cleared, set: [], loose: [table] });
}

function plan(source: Source, edit: TomlEdit): Planned {
  switch (edit.op) {
    case 'set': {
      return planSet(source, edit.path, edit.value);
    }
    case 'remove': {
      return planRemove(source, edit.path);
    }
    case 'add-section': {
      return planAddSection(source, edit.table, edit.entries);
    }
    case 'remove-section': {
      return planRemoveSection(source, edit.table);
    }
  }
}

/** Apply one edit to TOML text in memory. */
export function applyTomlEdit(text: string, edit: TomlEdit): TomlEditResult {
  const read = readSource(text);
  if (!read.ok) {
    return { ok: false, error: `The file was left alone because ${read.error}` };
  }
  const planResult = plan(read.value, edit);
  if (!planResult.ok) {
    return planResult;
  }
  const change = planResult.value;
  if (change.text === text) {
    return { ok: true, text, changed: false };
  }
  const after = readSource(change.text);
  const problem = after.ok
    ? verifyEdit(read.value.data, after.value.data, change.expect)
    : `the edit made ${after.error}`;
  return problem === null
    ? { ok: true, text: change.text, changed: true }
    : { ok: false, error: `The file was left alone because ${problem}` };
}

/** Apply edits one after another, stopping at the first that fails. */
export function applyTomlEdits(text: string, edits: readonly TomlEdit[]): TomlEditResult {
  let current = text;
  for (const edit of edits) {
    const result = applyTomlEdit(current, edit);
    if (!result.ok) {
      return result;
    }
    current = result.text;
  }
  return { ok: true, text: current, changed: current !== text };
}

async function restore(target: string, previous: string | null): Promise<void> {
  await (previous === null
    ? rm(target, { force: true })
    : writeFileAtomic({ target, content: previous, backup: null }));
}

/**
 * Edit a TOML file in place. The old file is kept as <file>.bak and the new
 * one is swapped in atomically. If what lands on disk is not what was
 * checked, the old content goes back.
 */
export async function editTomlFile(
  file: string,
  edits: TomlEdit | readonly TomlEdit[],
): Promise<TomlFileResult> {
  const list: readonly TomlEdit[] = isArray(edits) ? edits : [edits];
  try {
    const target = await resolveLinkTarget(file);
    const existing = await readOptional(target);
    const result = applyTomlEdits(existing ?? '', list);
    if (!result.ok) {
      return { ok: false, error: `${target}: ${result.error}` };
    }
    if (!result.changed) {
      return { ok: true, file: target, changed: false, backup: null };
    }
    const backup = existing === null ? null : `${target}.bak`;
    await writeFileAtomic({ target, content: result.text, backup });
    if ((await readOptional(target)) !== result.text) {
      await restore(target, existing);
      return {
        ok: false,
        error: `${target} changed while it was being written, so the old content was put back.`,
      };
    }
    return { ok: true, file: target, changed: true, backup };
  } catch (error) {
    return { ok: false, error: `Cannot write ${file}: ${errorMessage(error)}` };
  }
}
