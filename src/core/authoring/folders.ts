// The project folders an agent reads skills and agent files from, and where
// one skill or agent file sits in a folder. Each adapter lists its folders
// with these, so the walks match across agents.

import path from 'node:path';

import type { LibraryFolder, LibraryScope } from '../agents/types.js';
import { isInside } from '../context/path-tools.js';

/** cwd and every folder above it up to the git root, cwd first. Only cwd outside git. */
export function cwdToGitRoot(cwd: string, gitRoot: string | null): string[] {
  const out = [cwd];
  let dir = cwd;
  while (gitRoot !== null && dir !== gitRoot && isInside(gitRoot, dir)) {
    dir = path.dirname(dir);
    out.push(dir);
  }
  return out;
}

/** cwd, then the git root when it is a different folder. */
export function cwdAndGitRoot(cwd: string, gitRoot: string | null): string[] {
  return gitRoot === null || gitRoot === cwd ? [cwd] : [cwd, gitRoot];
}

/** A folder Overlord may write. */
export function folder(dir: string, scope: LibraryScope): LibraryFolder {
  return { dir, scope, prefix: '', writable: true };
}

/** A folder Overlord only reads. */
export function readOnlyFolder(dir: string, scope: LibraryScope, prefix = ''): LibraryFolder {
  return { dir, scope, prefix, writable: false };
}

/** Project folders: the same relative folders under each project folder, in walk order. */
export function projectFolders(
  dirs: readonly string[],
  relative: readonly string[],
): LibraryFolder[] {
  return dirs.flatMap((dir) => relative.map((name) => folder(path.join(dir, name), 'project')));
}

/** The SKILL.md of a skill named name in a skills folder. */
export function skillFileIn(dir: string, name: string): string {
  return path.join(dir, name, 'SKILL.md');
}

/** An agent file named name in an agents folder. */
export function agentFileIn(dir: string, name: string, suffix: string): string {
  return path.join(dir, `${name}${suffix}`);
}

/** A file name without the suffix, or without .md when it has another one. */
export function baseName(file: string, suffix: string): string {
  const name = path.basename(file);
  if (name.endsWith(suffix)) {
    return name.slice(0, -suffix.length);
  }
  return name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
}
