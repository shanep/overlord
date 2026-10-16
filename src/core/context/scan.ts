// Bounded directory walks. A repo can hold a huge tree, so the nested scan
// stops at a dir count and depth, and always adds the dirs of touched files.

import path from 'node:path';

import { byCodePoint, type FileSystem } from './fs.js';
import { isInside } from './path-tools.js';
import type { ScanLimits } from './types.js';

const SKIPPED_DIRS = new Set(['node_modules']);

function shouldDescend(name: string): boolean {
  return !name.startsWith('.') && !SKIPPED_DIRS.has(name);
}

async function childDirs(fs: FileSystem, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await fs.readdir(dir)) {
    const child = path.join(dir, name);
    if (shouldDescend(name) && (await fs.kind(child)) === 'directory') {
      out.push(child);
    }
  }
  return out;
}

/** Directories strictly between `root` and each touched file. */
export function touchedDirs(root: string, touched: readonly string[]): string[] {
  const out = new Set<string>();
  for (const file of touched) {
    let dir = path.dirname(path.resolve(file));
    while (dir !== root && isInside(root, dir)) {
      out.add(dir);
      dir = path.dirname(dir);
    }
  }
  return [...out];
}

/**
 * Subdirectories below `root` (not root itself), breadth first within the
 * limits, plus every directory that holds a touched file. Sorted.
 */
export async function listSubdirectories(
  fs: FileSystem,
  root: string,
  touched: readonly string[],
  limits: ScanLimits,
): Promise<string[]> {
  const found = new Set<string>();
  let level = [root];
  for (let depth = 1; depth <= limits.maxDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      for (const child of await childDirs(fs, dir)) {
        if (found.size >= limits.maxDirs) {
          break;
        }
        found.add(child);
        next.push(child);
      }
    }
    level = next;
  }
  for (const dir of touchedDirs(root, touched)) {
    found.add(dir);
  }
  return [...found].toSorted(byCodePoint);
}

async function collectMarkdown(
  fs: FileSystem,
  dir: string,
  seen: Set<string>,
  out: string[],
): Promise<void> {
  const real = await fs.realpath(dir);
  // Symlinked rule dirs can loop, so each real dir is read once.
  if (real === null || seen.has(real)) {
    return;
  }
  seen.add(real);
  for (const name of await fs.readdir(dir)) {
    const child = path.join(dir, name);
    const kind = await fs.kind(child);
    if (kind === 'directory') {
      await collectMarkdown(fs, child, seen, out);
    } else if (kind === 'file' && name.endsWith('.md')) {
      out.push(child);
    }
  }
}

/** Every `.md` file under `dir`, recursively, following symlinks once. */
export async function listMarkdownFiles(fs: FileSystem, dir: string): Promise<string[]> {
  const out: string[] = [];
  await collectMarkdown(fs, dir, new Set<string>(), out);
  return out;
}
