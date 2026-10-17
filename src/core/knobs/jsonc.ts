// JSON with comments (JSONC), as Copilot CLI's settings.json allows. Reading
// drops line and block comments and trailing commas outside strings. Writing
// keeps the comments at the top of the file, which Copilot writes itself, and
// refuses a file with comments further down, since rewriting it from parsed
// JSON would lose them.

import { parseJson, type ParsedJson } from './json.js';

interface Scan {
  /** The text with each comment blanked out, so positions stay the same. */
  readonly code: string;
  /** Where the first character that is not a comment or whitespace starts, or the length. */
  readonly start: number;
}

const BLANK = /[^\n]/gu;

/** The end of the string literal that opens at `index`, just past its closing quote. */
function stringEnd(text: string, index: number): number {
  let at = index + 1;
  while (at < text.length && text[at] !== '"') {
    at += text[at] === '\\' ? 2 : 1;
  }
  return at + 1;
}

/** The end of the comment that opens at `index`, or -1 when no comment opens there. */
function commentEnd(text: string, index: number): number {
  if (text.startsWith('//', index)) {
    const newline = text.indexOf('\n', index);
    return newline === -1 ? text.length : newline;
  }
  if (text.startsWith('/*', index)) {
    const close = text.indexOf('*/', index + 2);
    return close === -1 ? text.length : close + 2;
  }
  return -1;
}

function scan(text: string): Scan {
  let code = '';
  let start = -1;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const end = char === '"' ? -1 : commentEnd(text, index);
    if (end !== -1) {
      code += text.slice(index, end).replaceAll(BLANK, ' ');
      index = end;
      continue;
    }
    if (start === -1 && char.trim() !== '') {
      start = index;
    }
    const next = char === '"' ? stringEnd(text, index) : index + 1;
    code += text.slice(index, next);
    index = next;
  }
  return { code, start: start === -1 ? text.length : start };
}

/** A comma followed only by whitespace before a closing brace or bracket. */
const TRAILING_COMMA = /,(?=\s*[}\]])/gu;

/** The text with comments and trailing commas gone. Commas inside strings stay. */
export function stripJsonc(text: string): string {
  const { code } = scan(text);
  let out = '';
  let index = 0;
  while (index < code.length) {
    if (code[index] === '"') {
      const end = stringEnd(code, index);
      out += code.slice(index, end);
      index = end;
      continue;
    }
    const next = code.indexOf('"', index);
    const stop = next === -1 ? code.length : next;
    out += code.slice(index, stop).replaceAll(TRAILING_COMMA, '');
    index = stop;
  }
  return out;
}

export function parseJsonc(text: string): ParsedJson {
  return parseJson(stripJsonc(text));
}

export interface JsoncParts {
  /** The comments and blank lines before the JSON, ending in a newline, or "". */
  readonly header: string;
  /** The rest of the file, from the line the JSON starts on. */
  readonly body: string;
}

/** Split a file into the comment lines at its top and the JSON after them. */
export function splitHeader(text: string): JsoncParts {
  const { start } = scan(text);
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  return { header: text.slice(0, lineStart), body: text.slice(lineStart) };
}
