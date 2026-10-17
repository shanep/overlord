// Which files installing an entry copies: a skill's whole folder, so its
// scripts and references come along, or an agent's one file. A skill found
// through skills.sh is located by its folder name, then by the name in its
// frontmatter. Limits keep a mistaken pick from copying a huge folder.

import path from 'node:path';

import type { CatalogKind } from '../../shared/catalog.js';

import type { GitHubReader, RepoFile } from './github.js';
import type { FoundEntry } from './list.js';
import { readFrontmatter } from './list.js';

export const MAX_FILES = 200;
const MAX_BYTES = 10 * 1024 * 1024;
/** SKILL.md files read to match a frontmatter name when no folder has the skill's name. */
const MAX_NAME_READS = 40;

export interface InstallFiles {
  /** The entry file: the SKILL.md or the agent's .md. */
  readonly entryPath: string;
  /** Repository paths to copy, the entry file among them. */
  readonly files: readonly RepoFile[];
}

/** A path inside the entry's folder, or null when it would land outside. */
export function relativeInside(folder: string, filePath: string): string | null {
  const relative = path.posix.relative(folder, filePath);
  return relative === '' || relative.startsWith('..') || path.posix.isAbsolute(relative)
    ? null
    : relative;
}

async function findSkill(
  reader: GitHubReader,
  repo: string,
  files: readonly RepoFile[],
  skillId: string,
): Promise<string> {
  const skills = files
    .map((file) => file.path)
    .filter((filePath) => path.posix.basename(filePath) === 'SKILL.md')
    .toSorted((left, right) => left.length - right.length);
  const byFolder = skills.find(
    (filePath) => path.posix.basename(path.posix.dirname(filePath)) === skillId,
  );
  if (byFolder !== undefined) {
    return byFolder;
  }
  for (const filePath of skills.slice(0, MAX_NAME_READS)) {
    const front = readFrontmatter(await reader.text(repo, filePath).catch(() => ''));
    if (front.name === skillId) {
      return filePath;
    }
  }
  throw new Error(`Could not find the ${skillId} skill in ${repo}.`);
}

export async function installFiles(
  reader: GitHubReader,
  kind: CatalogKind,
  found: FoundEntry,
): Promise<InstallFiles> {
  const { repo } = found.entry;
  const all = await reader.files(repo);
  const entryPath = found.path ?? (await findSkill(reader, repo, all, found.skillId ?? ''));
  if (kind === 'agent') {
    const file = all.find((candidate) => candidate.path === entryPath);
    if (file === undefined) {
      throw new Error(`${entryPath} is no longer in ${repo}.`);
    }
    return { entryPath, files: [file] };
  }
  const folder = path.posix.dirname(entryPath);
  const files = all.filter((file) => relativeInside(folder, file.path) !== null);
  if (!files.some((file) => file.path === entryPath)) {
    throw new Error(`${entryPath} is no longer in ${repo}.`);
  }
  const bytes = files.reduce((total, file) => total + file.size, 0);
  if (files.length > MAX_FILES || bytes > MAX_BYTES) {
    throw new Error(
      `The ${folder} folder in ${repo} has ${String(files.length)} files and ${String(Math.round(bytes / 1024))} KB, more than a skill should. Install it by hand if you meant to.`,
    );
  }
  return { entryPath, files };
}
