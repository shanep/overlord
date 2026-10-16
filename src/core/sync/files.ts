// Small file system helpers that turn "missing" into null instead of a throw.

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';

import { compareStrings, parseJson } from './json.js';

export interface DirEntry {
  readonly name: string;
  readonly path: string;
  /** True for a directory, or a symlink that resolves to one. */
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

export async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch {
    return null;
  }
}

export async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

export async function pathExists(target: string): Promise<boolean> {
  return (await lstatOrNull(target)) !== null;
}

export async function readTextOrNull(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/** Parsed JSON, or undefined when the file is missing or not JSON. */
export async function readJsonOrUndefined(target: string): Promise<unknown> {
  const text = await readTextOrNull(target);
  return text === null ? undefined : parseJson(text);
}

export async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/** True when `child` is `parent` or sits somewhere under it. */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  const up = relative === '..' || relative.startsWith(`..${path.sep}`);
  return !up && !path.isAbsolute(relative);
}

/** Entries of a directory sorted by name. Missing directories read as empty. */
export async function listDir(dir: string): Promise<readonly DirEntry[]> {
  let names: readonly string[];
  try {
    const raw = await readdir(dir);
    names = raw.toSorted(compareStrings);
  } catch {
    return [];
  }
  const entries: DirEntry[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    const link = await lstatOrNull(full);
    const target = await statOrNull(full);
    entries.push({
      name,
      path: full,
      isDirectory: target?.isDirectory() === true,
      isSymlink: link?.isSymbolicLink() === true,
    });
  }
  return entries;
}

/** Every file under `dir` (following symlinks), as sorted paths relative to it. */
export async function listFilesRecursive(dir: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await listDir(current)) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(entry.path, relative);
      } else {
        found.push(relative);
      }
    }
  };
  await walk(dir, '');
  return found;
}

export function hashText(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Content hash of a file or a whole directory tree, or null when it is missing. */
export async function hashPath(target: string): Promise<string | null> {
  const info = await statOrNull(target);
  if (info === null) {
    return null;
  }
  if (!info.isDirectory()) {
    return hashText(await readFile(target));
  }
  const lines: string[] = [];
  for (const file of await listFilesRecursive(target)) {
    lines.push(`${file}\0${hashText(await readFile(path.join(target, file)))}`);
  }
  return hashText(lines.join('\n'));
}

/**
 * Copy a file, symlink or directory tree. Links are copied as links, and
 * modification times are kept so newest-wins comparisons still work.
 */
export async function copyPath(source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await rm(target, { force: true, recursive: true });
    await symlink(await readlink(source), target);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source)) {
      await copyPath(path.join(source, name), path.join(target, name));
    }
  } else {
    await copyFile(source, target);
  }
  await utimes(target, info.atime, info.mtime);
}
