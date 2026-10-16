// `@path` imports in memory files. Claude Code skips code spans and fenced
// code blocks when it looks for imports, so this scanner tracks both.

import path from 'node:path';

import type { FileSystem } from './fs.js';
import { expandHome } from './path-tools.js';

/** Imported files can import others, up to this many hops from the root file. */
export const MAX_IMPORT_HOPS = 4;

export interface ImportRef {
  /** The path as written, with `\ ` escapes turned into spaces. */
  readonly raw: string;
  /** 1-based line of the `@`. */
  readonly line: number;
  /** True when the `@` sits in a code span or fenced block, so it does not import. */
  readonly inCode: boolean;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}']);

interface Fence {
  readonly char: string;
  readonly length: number;
}

function fenceOf(line: string): Fence | null {
  const run = FENCE.exec(line)?.[1];
  return run === undefined ? null : { char: run.charAt(0), length: run.length };
}

function closesFence(line: string, open: Fence): boolean {
  const fence = fenceOf(line);
  const trimmed = line.trim();
  // A closing fence holds only fence characters, no info string.
  return (
    fence !== null &&
    fence.char === open.char &&
    fence.length >= open.length &&
    trimmed === open.char.repeat(trimmed.length)
  );
}

function runLength(line: string, start: number): number {
  let end = start;
  while (line.charAt(end) === '`') {
    end += 1;
  }
  return end - start;
}

/** Index just past the closing run of exactly `size` backticks, or -1. */
function closingRun(line: string, from: number, size: number): number {
  let index = from;
  while (index < line.length) {
    if (line.charAt(index) === '`') {
      const length = runLength(line, index);
      if (length === size) {
        return index + length;
      }
      index += length;
    } else {
      index += 1;
    }
  }
  return -1;
}

/** One flag per character: true where the character is part of a code span. */
export function codeSpanMask(line: string): boolean[] {
  const mask = Array.from({ length: line.length }, () => false);
  let index = 0;
  while (index < line.length) {
    if (line.charAt(index) !== '`') {
      index += 1;
      continue;
    }
    const size = runLength(line, index);
    const end = closingRun(line, index + size, size);
    if (end === -1) {
      index += size;
      continue;
    }
    mask.fill(true, index, end);
    index = end;
  }
  return mask;
}

/** Reads the path after an `@`, honoring backslash-escaped spaces. */
function readPath(line: string, start: number): string {
  let out = '';
  let index = start;
  while (index < line.length) {
    const char = line.charAt(index);
    if (char === '\\' && line.charAt(index + 1) === ' ') {
      out += ' ';
      index += 2;
    } else if (char === '`' || /\s/u.test(char)) {
      break;
    } else {
      out += char;
      index += 1;
    }
  }
  // Prose punctuation after a path ("see @README.") is not part of it.
  let end = out.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(out.charAt(end - 1))) {
    end -= 1;
  }
  return out.slice(0, end);
}

function refsInLine(line: string, lineNumber: number, inFence: boolean): ImportRef[] {
  const mask = codeSpanMask(line);
  const out: ImportRef[] = [];
  for (let index = 0; index < line.length; index += 1) {
    const before = line.charAt(index - 1);
    // `@README` in backticks is the documented way to keep a path literal, so
    // it counts as a reference (in code) even though a backtick precedes it.
    const startsToken =
      index === 0 || /\s/u.test(before) || (before === '`' && mask[index] === true);
    if (line.charAt(index) !== '@' || !startsToken) {
      continue;
    }
    const raw = readPath(line, index + 1);
    // A quoted path is never imported, with or without escapes.
    if (raw === '' || raw.startsWith('"') || raw.startsWith("'")) {
      continue;
    }
    out.push({ raw, line: lineNumber, inCode: inFence || mask[index] === true });
  }
  return out;
}

/** Every `@path` reference in a markdown file, including ones inside code. */
export function findImports(markdown: string): ImportRef[] {
  const out: ImportRef[] = [];
  let open: Fence | null = null;
  for (const [index, line] of markdown.split('\n').entries()) {
    if (open === null) {
      open = fenceOf(line);
      out.push(...refsInLine(line, index + 1, open !== null));
    } else {
      out.push(...refsInLine(line, index + 1, true));
      open = closesFence(line, open) ? null : open;
    }
  }
  return out;
}

/** Imports resolve against the importing file's directory, and `~/` against home. */
export function resolveImportPath(raw: string, fromFile: string, home: string): string {
  const expanded = expandHome(raw, home);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(path.dirname(fromFile), expanded);
}

export interface ImportNode {
  readonly path: string;
  readonly parentPath: string;
  /** Hops from the root file: a direct import is 1. */
  readonly depth: number;
  readonly inCode: boolean;
  readonly exists: boolean;
  readonly text: string | null;
}

interface WalkState {
  readonly fs: FileSystem;
  readonly home: string;
  readonly seen: Set<string>;
  readonly out: ImportNode[];
}

async function visit(state: WalkState, file: string, text: string, depth: number): Promise<void> {
  const refs = findImports(text);
  // Real imports first, so a path that also appears in a code span still loads.
  const ordered = [...refs.filter((ref) => !ref.inCode), ...refs.filter((ref) => ref.inCode)];
  for (const ref of ordered) {
    const target = resolveImportPath(ref.raw, file, state.home);
    if (state.seen.has(target)) {
      continue;
    }
    state.seen.add(target);
    const isFile = (await state.fs.kind(target)) === 'file';
    const read = isFile && !ref.inCode && depth < MAX_IMPORT_HOPS;
    const body = read ? await state.fs.readFile(target) : null;
    state.out.push({
      path: target,
      parentPath: file,
      depth: depth + 1,
      inCode: ref.inCode,
      exists: isFile,
      text: body,
    });
    if (body !== null) {
      await visit(state, target, body, depth + 1);
    }
  }
}

/**
 * Walks imports from one root file, depth first in document order. Each path
 * appears once, which also stops cycles. Nodes past MAX_IMPORT_HOPS are
 * reported but not read.
 */
export async function walkImports(
  fs: FileSystem,
  root: { readonly path: string; readonly text: string },
  home: string,
  seen: Set<string> = new Set<string>(),
): Promise<ImportNode[]> {
  const state: WalkState = { fs, home, seen, out: [] };
  seen.add(root.path);
  await visit(state, root.path, root.text, 0);
  return state.out;
}
