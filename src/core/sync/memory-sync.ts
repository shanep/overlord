// Auto memory sync. ~/.claude/projects/<encoded cwd>/memory maps to
// memory/<remote slug>/ in the config repo, keyed by the project's git remote
// so the same project matches on every machine. Each file syncs both ways
// against the hash it had at the last sync. When both sides changed, the
// newer file wins and the pair is reported as a conflict. Anything
// overwritten or removed is backed up first.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { Exec } from './exec.js';
import { copyPath, hashPath, listFilesRecursive, readTextOrNull, statOrNull } from './files.js';
import { remoteUrl, repoRootOf } from './git.js';
import { compareStrings, parseJson, stableJson } from './json.js';
import { memoryPath, remoteSlug, repoFile } from './layout.js';
import { scanForSecrets, type SecretRule } from './secrets.js';

export interface MemoryProject {
  /** ~/.claude/projects/<encoded cwd> */
  readonly projectDir: string;
  /** The project's working directory, used to find its git remote. */
  readonly cwd: string;
}

export interface MemorySyncOptions {
  readonly projects: readonly MemoryProject[];
  readonly repoRoot: string;
  readonly exec: Exec;
  /** Per machine record of each file's hash at the last sync. Keep it outside the repo. */
  readonly statePath: string;
  /** Files about to be overwritten or removed are copied here first. */
  readonly backupDir: string;
}

type Side = 'local' | 'repo';

export interface ProjectSync {
  readonly projectDir: string;
  readonly slug: string;
  readonly toRepo: readonly string[];
  readonly toLocal: readonly string[];
  readonly removedFromRepo: readonly string[];
  readonly removedLocal: readonly string[];
  readonly conflicts: readonly { readonly file: string; readonly winner: Side }[];
  /** Local files kept out of the repo because they look like they hold a secret. */
  readonly blocked: readonly { readonly file: string; readonly rules: readonly SecretRule[] }[];
}

type SkipReason = 'not-a-git-repo' | 'no-remote' | 'remote-not-portable';

export interface MemorySyncResult {
  readonly synced: readonly ProjectSync[];
  readonly skipped: readonly { readonly projectDir: string; readonly reason: SkipReason }[];
}

export type FileDecision =
  'none' | 'to-repo' | 'to-local' | 'remove-repo' | 'remove-local' | 'conflict';

/** Three way decision from the local hash, the repo hash and the hash at the last sync. */
export function decideFile(
  local: string | null,
  repo: string | null,
  base: string | null,
): FileDecision {
  if (local === repo) {
    return 'none';
  }
  if (repo === base) {
    return local === null ? 'remove-repo' : 'to-repo';
  }
  if (local === base) {
    return repo === null ? 'remove-local' : 'to-local';
  }
  return 'conflict';
}

const stateSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), z.record(z.string(), z.string())),
});

type State = z.output<typeof stateSchema>;
type FileHashes = Record<string, string>;

export async function readMemoryState(statePath: string): Promise<State> {
  const text = await readTextOrNull(statePath);
  const parsed = stateSchema.safeParse(text === null ? undefined : parseJson(text));
  return parsed.success ? parsed.data : { version: 1, projects: {} };
}

interface Dirs {
  readonly local: string;
  readonly repo: string;
  readonly backup: string;
}

class ProjectRun {
  readonly toRepo: string[] = [];
  readonly toLocal: string[] = [];
  readonly removedFromRepo: string[] = [];
  readonly removedLocal: string[] = [];
  readonly conflicts: { file: string; winner: Side }[] = [];
  readonly blocked: { file: string; rules: SecretRule[] }[] = [];
  readonly dirs: Dirs;
  readonly hashes: FileHashes;

  constructor(dirs: Dirs, hashes: FileHashes) {
    this.dirs = dirs;
    this.hashes = hashes;
  }

  where(side: Side, file: string): string {
    return path.join(side === 'local' ? this.dirs.local : this.dirs.repo, ...file.split('/'));
  }

  async backup(side: Side, file: string): Promise<void> {
    const source = this.where(side, file);
    if ((await statOrNull(source)) === null) {
      return;
    }
    const destination = path.join(this.dirs.backup, side, ...file.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyPath(source, destination);
  }

  /** Copy `file` from one side to the other. Returns false when a secret scan blocks it. */
  async copy(from: Side, file: string): Promise<boolean> {
    const source = this.where(from, file);
    if (from === 'local') {
      const text = await readFile(source, 'utf8');
      const rules = scanForSecrets(text).map((found) => found.rule);
      if (rules.length > 0) {
        this.blocked.push({ file, rules: [...new Set(rules)] });
        return false;
      }
    }
    const to: Side = from === 'local' ? 'repo' : 'local';
    await this.backup(to, file);
    const target = this.where(to, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyPath(source, target);
    (from === 'local' ? this.toRepo : this.toLocal).push(file);
    return true;
  }

  async remove(side: Side, file: string): Promise<void> {
    await this.backup(side, file);
    await rm(this.where(side, file), { force: true });
    (side === 'local' ? this.removedLocal : this.removedFromRepo).push(file);
  }

  async newer(file: string, local: string | null, repo: string | null): Promise<Side> {
    if (local === null || repo === null) {
      return local === null ? 'repo' : 'local';
    }
    const localInfo = await stat(this.where('local', file));
    const repoInfo = await stat(this.where('repo', file));
    return localInfo.mtimeMs >= repoInfo.mtimeMs ? 'local' : 'repo';
  }

  /** Carry out a decision. Returns false when the file was left out of sync on purpose. */
  async act(
    decision: FileDecision,
    file: string,
    local: string | null,
    repo: string | null,
  ): Promise<boolean> {
    switch (decision) {
      case 'to-repo': {
        return this.copy('local', file);
      }
      case 'to-local': {
        return this.copy('repo', file);
      }
      case 'remove-repo': {
        await this.remove('repo', file);
        return true;
      }
      case 'remove-local': {
        await this.remove('local', file);
        return true;
      }
      case 'conflict': {
        const winner = await this.newer(file, local, repo);
        this.conflicts.push({ file, winner });
        return this.copy(winner, file);
      }
      case 'none': {
        return true;
      }
    }
  }

  async syncFile(file: string): Promise<void> {
    const local = await hashPath(this.where('local', file));
    const repo = await hashPath(this.where('repo', file));
    const decision = decideFile(local, repo, this.hashes[file] ?? null);
    if (await this.act(decision, file, local, repo)) {
      await this.record(file);
    }
  }

  async record(file: string): Promise<void> {
    const latest = await hashPath(this.where('local', file));
    if (latest === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- dropping a file from the state map
      delete this.hashes[file];
    } else {
      this.hashes[file] = latest;
    }
  }
}

type SlugLookup = { readonly slug: string } | { readonly skip: SkipReason };

async function slugFor(exec: Exec, cwd: string): Promise<SlugLookup> {
  const root = await repoRootOf(exec, cwd);
  if (root === null) {
    return { skip: 'not-a-git-repo' };
  }
  const url = await remoteUrl(exec, root);
  if (url === null) {
    return { skip: 'no-remote' };
  }
  const slug = remoteSlug(url);
  return slug === null ? { skip: 'remote-not-portable' } : { slug };
}

async function syncProject(
  project: MemoryProject,
  slug: string,
  options: MemorySyncOptions,
  state: State,
): Promise<ProjectSync> {
  const dirs: Dirs = {
    local: path.join(project.projectDir, 'memory'),
    repo: repoFile(options.repoRoot, memoryPath(slug)),
    backup: path.join(options.backupDir, ...slug.split('/')),
  };
  const hashes: FileHashes = { ...state.projects[project.projectDir] };
  const run = new ProjectRun(dirs, hashes);
  const files = new Set([
    ...(await listFilesRecursive(dirs.local)),
    ...(await listFilesRecursive(dirs.repo)),
    ...Object.keys(hashes),
  ]);
  for (const file of [...files].toSorted(compareStrings)) {
    await run.syncFile(file);
  }
  state.projects[project.projectDir] = hashes;
  return {
    projectDir: project.projectDir,
    slug,
    toRepo: run.toRepo,
    toLocal: run.toLocal,
    removedFromRepo: run.removedFromRepo,
    removedLocal: run.removedLocal,
    conflicts: run.conflicts,
    blocked: run.blocked,
  };
}

/** Sync auto memory for each project both ways with the config repo. */
export async function syncMemory(options: MemorySyncOptions): Promise<MemorySyncResult> {
  const state = await readMemoryState(options.statePath);
  const synced: ProjectSync[] = [];
  const skipped: { projectDir: string; reason: SkipReason }[] = [];
  for (const project of options.projects) {
    const lookup = await slugFor(options.exec, project.cwd);
    if ('skip' in lookup) {
      skipped.push({ projectDir: project.projectDir, reason: lookup.skip });
    } else {
      synced.push(await syncProject(project, lookup.slug, options, state));
    }
  }
  await mkdir(path.dirname(options.statePath), { recursive: true });
  await writeFile(options.statePath, stableJson(state));
  return { synced, skipped };
}
