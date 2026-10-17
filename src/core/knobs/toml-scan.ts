// A line-level map of a TOML file for toml-edit.ts: where each table header,
// key and value starts and ends, so an edit can touch those bytes and nothing
// else. It only runs on text smol-toml already parsed, so it can trust the
// syntax and only has to track strings, brackets and comments.

import { isArray } from './json.js';

/** A `[table]` or `[[array]]` header line. */
export interface TomlHeader {
  readonly kind: 'header';
  readonly path: readonly string[];
  /** True for `[[array]]`. */
  readonly array: boolean;
  /** True when this header or one above it is an array of tables. */
  readonly inArray: boolean;
  /** Offset of the line start. */
  readonly start: number;
  /** Offset just past the line's newline, or the end of the text. */
  readonly end: number;
}

/** A `key = value` statement, which may span lines (arrays, multi-line strings). */
export interface TomlPair {
  readonly kind: 'pair';
  /** The header above it, or [] for the root table. */
  readonly table: readonly string[];
  readonly inArray: boolean;
  /** The key as written, so `a.b = 1` gives ["a", "b"]. */
  readonly key: readonly string[];
  /** The leading spaces or tabs on its first line. */
  readonly indent: string;
  readonly start: number;
  readonly valueStart: number;
  /** Just past the value, before any trailing comment. */
  readonly valueEnd: number;
  readonly end: number;
  /** True when the value is an inline table. */
  readonly inline: boolean;
}

/** A blank or comment-only line. */
interface TomlTrivia {
  readonly kind: 'blank' | 'comment';
  readonly start: number;
  readonly end: number;
}

export type TomlStatement = TomlHeader | TomlPair | TomlTrivia;

const BARE_KEY = /^[\w-]+$/u;
const BARE_CHAR = /[\w-]/u;

const ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  e: '\u001B',
  '"': '"',
  '\\': '\\',
};

/** What a blank or comment line has after its indent: a newline, the end of the text, or #. */
const TRIVIA_START: ReadonlySet<string> = new Set(['\n', '\r', '', '#']);

const HEX_LENGTH: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/** The full key path of a pair: its table plus its own dotted key. */
export function pairPath(pair: TomlPair): readonly string[] {
  return [...pair.table, ...pair.key];
}

/** True when `path` equals `prefix` or sits under it. */
export function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

export function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && startsWith(left, right);
}

/** A TOML basic string, escaped so it parses back to the same text. */
function quoteTomlString(value: string): string {
  // JSON escapes are all valid TOML escapes, but JSON leaves DEL bare and TOML does not allow it.
  return JSON.stringify(value).replaceAll('\u007F', String.raw`\u007f`);
}

/** One key segment, bare when TOML allows it and quoted otherwise. */
function formatSegment(segment: string): string {
  return BARE_KEY.test(segment) ? segment : quoteTomlString(segment);
}

/** A dotted key such as mcp_servers."my.server".command. */
export function formatTomlKey(path: readonly string[]): string {
  return path.map((segment) => formatSegment(segment)).join('.');
}

type TomlScalar = string | number | boolean;

/** What the editor can write: a scalar or a flat array of scalars. */
export type TomlEditValue = TomlScalar | readonly TomlScalar[];

function formatNumber(value: number): string {
  if (Number.isNaN(value)) {
    return 'nan';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'inf' : '-inf';
  }
  const text = String(value);
  // A whole number past 2^53 is not a safe TOML integer, so write it as a float.
  return Number.isSafeInteger(value) || !/^-?\d+$/u.test(text) ? text : `${text}.0`;
}

function formatScalar(value: TomlScalar): string {
  if (typeof value === 'string') {
    return quoteTomlString(value);
  }
  return typeof value === 'number' ? formatNumber(value) : String(value);
}

/** A value as TOML text, as it would follow `key = ` or `-c key=`. */
export function formatTomlValue(value: TomlEditValue): string {
  return isArray(value)
    ? `[${value.map((item) => formatScalar(item)).join(', ')}]`
    : formatScalar(value);
}

class Cursor {
  constructor(
    readonly text: string,
    public pos: number,
  ) {}

  get char(): string {
    return this.text.charAt(this.pos);
  }

  at(offset: number): string {
    return this.text.charAt(this.pos + offset);
  }

  done(): boolean {
    return this.pos >= this.text.length;
  }

  skipSpaces(): void {
    while (this.char === ' ' || this.char === '\t') {
      this.pos += 1;
    }
  }

  /** Move just past the next newline, or to the end. */
  skipLine(): void {
    const newline = this.text.indexOf('\n', this.pos);
    this.pos = newline === -1 ? this.text.length : newline + 1;
  }

  fail(what: string): never {
    throw new Error(`Cannot read ${what} at offset ${String(this.pos)}.`);
  }
}

function readEscape(cursor: Cursor): string {
  const letter = cursor.char;
  cursor.pos += 1;
  const simple = ESCAPES[letter];
  if (simple !== undefined) {
    return simple;
  }
  const length = HEX_LENGTH[letter] ?? cursor.fail('an escape');
  const code = Number.parseInt(cursor.text.slice(cursor.pos, cursor.pos + length), 16);
  cursor.pos += length;
  return String.fromCodePoint(code);
}

/** A single-line basic or literal string, decoded. The cursor sits on the opening quote. */
function readQuoted(cursor: Cursor): string {
  const quote = cursor.char;
  cursor.pos += 1;
  let out = '';
  while (cursor.char !== quote) {
    if (cursor.done() || cursor.char === '\n') {
      cursor.fail('a quoted key');
    }
    if (quote === '"' && cursor.char === '\\') {
      cursor.pos += 1;
      out += readEscape(cursor);
    } else {
      out += cursor.char;
      cursor.pos += 1;
    }
  }
  cursor.pos += 1;
  return out;
}

function readSegment(cursor: Cursor): string {
  if (cursor.char === '"' || cursor.char === "'") {
    return readQuoted(cursor);
  }
  const start = cursor.pos;
  while (BARE_CHAR.test(cursor.char)) {
    cursor.pos += 1;
  }
  if (cursor.pos === start) {
    cursor.fail('a key');
  }
  return cursor.text.slice(start, cursor.pos);
}

/** A dotted key, leaving the cursor on the first character after it. */
function readKey(cursor: Cursor): readonly string[] {
  const segments: string[] = [];
  for (;;) {
    cursor.skipSpaces();
    segments.push(readSegment(cursor));
    cursor.skipSpaces();
    if (cursor.char !== '.') {
      return segments;
    }
    cursor.pos += 1;
  }
}

/** Skip a string of any kind. The cursor sits on its first quote. */
function skipString(cursor: Cursor): void {
  const quote = cursor.char;
  const triple = quote.repeat(3);
  const multi = cursor.text.startsWith(triple, cursor.pos);
  const close = multi ? triple : quote;
  cursor.pos += close.length;
  while (!cursor.text.startsWith(close, cursor.pos)) {
    if (cursor.done()) {
      cursor.fail('a string');
    }
    cursor.pos += quote === '"' && cursor.char === '\\' ? 2 : 1;
  }
  cursor.pos += close.length;
  // A multi-line string may end with one or two quotes of its own right before the closing three.
  for (let extra = 0; multi && extra < 2 && cursor.char === quote; extra += 1) {
    cursor.pos += 1;
  }
}

/** Skip an array or inline table, comments and newlines inside it included. */
function skipBracketed(cursor: Cursor): void {
  let depth = 0;
  do {
    if (cursor.done()) {
      cursor.fail('an array or inline table');
    }
    switch (cursor.char) {
      case '"':
      case "'": {
        skipString(cursor);
        continue;
      }
      case '#': {
        cursor.skipLine();
        continue;
      }
      case '[':
      case '{': {
        depth += 1;
        break;
      }
      case ']':
      case '}': {
        depth -= 1;
        break;
      }
      default: {
        break;
      }
    }
    cursor.pos += 1;
  } while (depth > 0);
}

/** Skip a number, boolean or date: everything up to a comment or the line end, minus trailing space. */
function skipBare(cursor: Cursor): void {
  while (!cursor.done() && cursor.char !== '#' && cursor.char !== '\n') {
    cursor.pos += 1;
  }
  while (/[\t\r ]/u.test(cursor.text.charAt(cursor.pos - 1))) {
    cursor.pos -= 1;
  }
}

function skipValue(cursor: Cursor): void {
  const char = cursor.char;
  if (char === '"' || char === "'") {
    skipString(cursor);
  } else if (char === '[' || char === '{') {
    skipBracketed(cursor);
  } else {
    skipBare(cursor);
  }
}

/** After a header or value: optional spaces and comment, then the newline. */
function finishLine(cursor: Cursor): number {
  cursor.skipSpaces();
  const char = cursor.char;
  if (char !== '#' && char !== '\r' && char !== '\n' && !cursor.done()) {
    cursor.fail('the end of the line');
  }
  cursor.skipLine();
  return cursor.pos;
}

interface TableContext {
  readonly path: readonly string[];
  readonly inArray: boolean;
}

function readHeader(cursor: Cursor, start: number, arrays: string[][]): TomlHeader {
  const array = cursor.at(1) === '[';
  cursor.pos += array ? 2 : 1;
  const path = readKey(cursor);
  cursor.pos += array ? 2 : 1;
  const end = finishLine(cursor);
  if (array) {
    arrays.push([...path]);
  }
  const inArray = arrays.some((prefix) => startsWith(path, prefix));
  return { kind: 'header', path, array, inArray, start, end };
}

function readPair(cursor: Cursor, start: number, table: TableContext): TomlPair {
  const indent = cursor.text.slice(start, cursor.pos);
  const key = readKey(cursor);
  if (cursor.char !== '=') {
    cursor.fail('an equals sign');
  }
  cursor.pos += 1;
  cursor.skipSpaces();
  const valueStart = cursor.pos;
  const inline = cursor.at(0) === '{';
  skipValue(cursor);
  const valueEnd = cursor.pos;
  const end = finishLine(cursor);
  return {
    kind: 'pair',
    table: table.path,
    inArray: table.inArray,
    key,
    indent,
    start,
    valueStart,
    valueEnd,
    end,
    inline,
  };
}

/** Every statement in a TOML text, in order. Throws on text that does not scan. */
export function scanToml(text: string): readonly TomlStatement[] {
  const cursor = new Cursor(text, 0);
  const statements: TomlStatement[] = [];
  const arrays: string[][] = [];
  let table: TableContext = { path: [], inArray: false };
  while (!cursor.done()) {
    const start = cursor.pos;
    cursor.skipSpaces();
    const char = cursor.char;
    if (TRIVIA_START.has(char)) {
      cursor.skipLine();
      statements.push({ kind: char === '#' ? 'comment' : 'blank', start, end: cursor.pos });
    } else if (char === '[') {
      const header = readHeader(cursor, start, arrays);
      table = { path: header.path, inArray: header.inArray };
      statements.push(header);
    } else {
      statements.push(readPair(cursor, start, table));
    }
  }
  return statements;
}

/** Split "a.\"b.c\".d" into ["a", "b.c", "d"], or null when it is not one TOML key. */
export function parseTomlKey(dotted: string): readonly string[] | null {
  const cursor = new Cursor(dotted, 0);
  try {
    const key = readKey(cursor);
    return cursor.done() ? key : null;
  } catch {
    return null;
  }
}
