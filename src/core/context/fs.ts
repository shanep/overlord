// The resolver only reads the disk through this interface, so tests can run
// against a temp dir or an in-memory fake.

import { readdir, readFile, realpath, stat } from 'node:fs/promises';

export type FileKind = 'file' | 'directory' | 'other';

export interface FileSystem {
  /** What sits at a path after following symlinks, or null when nothing does. */
  readonly kind: (target: string) => Promise<FileKind | null>;
  /** UTF-8 text, or null when the file cannot be read. */
  readonly readFile: (target: string) => Promise<string | null>;
  /** Entry names sorted by code point, or an empty list when the dir cannot be read. */
  readonly readdir: (target: string) => Promise<readonly string[]>;
  /** The path with every symlink resolved, or null when it does not exist. */
  readonly realpath: (target: string) => Promise<string | null>;
}

export function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export async function exists(fs: FileSystem, target: string): Promise<boolean> {
  return (await fs.kind(target)) !== null;
}

async function kindOf(target: string): Promise<FileKind | null> {
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      return 'directory';
    }
    return info.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

async function readText(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

async function listNames(target: string): Promise<readonly string[]> {
  try {
    const names = await readdir(target);
    return names.toSorted(byCodePoint);
  } catch {
    return [];
  }
}

async function resolveReal(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

export function createNodeFileSystem(): FileSystem {
  return { kind: kindOf, readFile: readText, readdir: listNames, realpath: resolveReal };
}
