// Every worktree Overlord made, from creation until its work lands. Each one
// is a small JSON file in the extension's storage folder, so every VS Code
// window sees the same set without fighting over one shared file.
//
// A worktree is in use while the window that made it still holds it, or while
// any live Claude Code process works inside it. Once nothing uses it, it goes
// away on its own if everything in it has landed. Otherwise it stays, with
// its edits or commits, until the user lands or discards it.

import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { WorktreeState, WorktreeSummary } from '../../shared/protocol.js';
import { readOptional, writeFileAtomic } from '../knobs/atomic-file.js';
import type { IsAlive } from '../surfaces/process.js';
import type { Exec } from '../sync/exec.js';

import { repoFolder, type WorktreeGit, type WorktreeInfo, type WorktreeStatus } from './git.js';
import { KeyedLock } from './lock.js';
import { withOverlaps } from './overlap.js';
import { setUpWorktree } from './setup.js';

type WorktreeKind = WorktreeSummary['kind'];

export interface WorktreeEntry extends WorktreeInfo {
  readonly kind: WorktreeKind;
  readonly label: string;
  /** Small number unique among worktrees in use, for ports and other shared resources. */
  readonly slot: number;
  readonly createdAt: number;
  /** The Overlord process holding the worktree open, or null once released. */
  readonly holderPid: number | null;
}

export interface Lease {
  readonly entry: WorktreeEntry;
  /** Variables a session in the worktree should get. */
  readonly env: Readonly<Record<string, string>>;
  /** Setup steps that failed. The worktree works without them. */
  readonly warnings: readonly string[];
}

export interface AcquireRequest {
  readonly cwd: string;
  readonly id: string;
  readonly kind: WorktreeKind;
  readonly label: string;
}

/** The git operations the registry uses, so tests can stand in for git. */
type WorktreeGitPort = Pick<WorktreeGit, 'repoRoot' | 'create' | 'status' | 'land' | 'remove'>;

export interface RegistryDeps {
  readonly git: WorktreeGitPort;
  readonly exec: Exec;
  /** Holds one JSON file per worktree, plus repos.json. */
  readonly dir: string;
  /** Where worktrees go, the same root the WorktreeGit was given. */
  readonly root: string;
  /** This Overlord's process id. */
  readonly pid: number;
  readonly isAlive: IsAlive;
  readonly clock: () => number;
  /** Working folders of every live Claude Code process. */
  readonly liveCwds: () => Promise<readonly string[]>;
}

/** Ports for a slot start here, PORT_STEP apart. */
export const PORT_BASE = 40_000;
export const PORT_STEP = 100;
const REPOS_FILE = 'repos.json';

const entrySchema = z.object({
  id: z.string().min(1),
  repoRoot: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseCommit: z.string(),
  target: z.string().nullable(),
  kind: z.enum(['run', 'session']),
  label: z.string(),
  slot: z.number().int().nonnegative(),
  createdAt: z.number(),
  holderPid: z.number().int().nullable(),
});

const reposSchema = z.record(z.string(), z.string());

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function worktreeEnv(entry: Pick<WorktreeEntry, 'id' | 'slot'>): Record<string, string> {
  return {
    OVERLORD_WORKTREE_ID: entry.id,
    OVERLORD_SLOT: String(entry.slot),
    OVERLORD_PORT_BASE: String(PORT_BASE + entry.slot * PORT_STEP),
  };
}

/** The smallest slot no worktree in use has. */
export function freeSlot(used: readonly number[]): number {
  const taken = new Set(used);
  let slot = 0;
  while (taken.has(slot)) {
    slot += 1;
  }
  return slot;
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

// Claude Code's own worktrees sit at <repo>/.claude/worktrees/<name>.
const CLAUDE_WORKTREE = `${path.sep}.claude${path.sep}worktrees${path.sep}`;

/**
 * The repository a session folder belongs to. Overlord's worktrees map back
 * through repos.json and Claude Code's through their path. Anything else is
 * its own project.
 */
export function projectFolder(
  cwd: string,
  root: string,
  repos: Readonly<Record<string, string>>,
): string {
  const known = Object.entries(repos).find(([folder]) => isInside(cwd, path.join(root, folder)));
  if (known !== undefined) {
    return known[1];
  }
  const marker = cwd.indexOf(CLAUDE_WORKTREE);
  return marker > 0 ? cwd.slice(0, marker) : cwd;
}

function stateOf(inUse: boolean, status: WorktreeStatus): WorktreeState {
  if (inUse) {
    return 'active';
  }
  if (!status.exists) {
    return 'missing';
  }
  if (status.dirty > 0) {
    return 'dirty';
  }
  return status.ahead > 0 ? 'unlanded' : 'landed';
}

export class WorktreeRegistry {
  private readonly lock = new KeyedLock();
  private repos: Readonly<Record<string, string>> = {};

  constructor(private readonly deps: RegistryDeps) {}

  /** Loads the repository map that projectFor reads. */
  async load(): Promise<void> {
    const text = await readOptional(path.join(this.deps.dir, REPOS_FILE));
    const parsed = reposSchema.safeParse(text === null ? {} : safeJson(text));
    this.repos = parsed.success ? parsed.data : {};
  }

  /** The repository a session folder belongs to. */
  readonly projectFor = (cwd: string): string => projectFolder(cwd, this.deps.root, this.repos);

  async entries(): Promise<readonly WorktreeEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.deps.dir);
    } catch {
      return [];
    }
    const entries: WorktreeEntry[] = [];
    for (const name of names.filter((file) => file.endsWith('.json') && file !== REPOS_FILE)) {
      // A file that vanished or cannot be read is skipped like a malformed one.
      const text = await readOptional(path.join(this.deps.dir, name)).catch(() => null);
      const parsed = entrySchema.safeParse(safeJson(text ?? ''));
      if (parsed.success) {
        entries.push(parsed.data);
      }
    }
    return entries.toSorted((a, b) => a.createdAt - b.createdAt);
  }

  /** Makes a worktree for cwd's repository, sets it up and holds it for this process. */
  async acquire(request: AcquireRequest): Promise<Lease> {
    const repoRoot = await this.deps.git.repoRoot(request.cwd);
    const entries = await this.entries();
    const slot = freeSlot(entries.filter((entry) => this.held(entry)).map((entry) => entry.slot));
    const info = await this.lock.run(repoRoot, async () =>
      this.deps.git.create(request.cwd, request.id),
    );
    const entry: WorktreeEntry = {
      ...info,
      kind: request.kind,
      label: request.label,
      slot,
      createdAt: this.deps.clock(),
      holderPid: this.deps.pid,
    };
    await this.save(entry);
    await this.rememberRepo(info.repoRoot);
    const env = worktreeEnv(entry);
    const warnings = await setUpWorktree(this.deps.exec, info, env);
    return { entry, env, warnings };
  }

  /** Holds a worktree that already exists, to open another session in it. */
  async hold(id: string): Promise<Lease> {
    const current = await this.find(id);
    const entries = await this.entries();
    const others = entries.filter((entry) => entry.id !== id && this.held(entry));
    const slot = freeSlot(others.map((entry) => entry.slot));
    const entry: WorktreeEntry = { ...current, slot, holderPid: this.deps.pid };
    await this.save(entry);
    return { entry, env: worktreeEnv(entry), warnings: [] };
  }

  /** Lets go of a worktree and removes it when everything in it has landed. */
  async release(id: string): Promise<WorktreeState | null> {
    const entry = await this.findOrNull(id);
    if (entry === null) {
      return null;
    }
    const released = { ...entry, holderPid: null };
    await this.save(released);
    return this.tidy(released, await this.deps.liveCwds());
  }

  /** Tidies every worktree: forgets missing ones and removes landed ones nothing uses. */
  async reconcile(): Promise<void> {
    const live = await this.deps.liveCwds();
    for (const entry of await this.entries()) {
      await this.tidy(entry, live);
    }
  }

  /** Every worktree with its state and the files it shares with others. */
  async summaries(): Promise<readonly WorktreeSummary[]> {
    const live = await this.deps.liveCwds();
    const entries = await this.entries();
    const rows = await Promise.all(
      entries.map(async (entry): Promise<Omit<WorktreeSummary, 'overlaps'>> => {
        const status = await this.deps.git.status(entry);
        return {
          id: entry.id,
          kind: entry.kind,
          label: entry.label,
          repoRoot: entry.repoRoot,
          path: entry.path,
          branch: entry.branch,
          target: entry.target,
          slot: entry.slot,
          createdAt: entry.createdAt,
          state: stateOf(this.inUse(entry, live), status),
          ahead: status.ahead,
          dirty: status.dirty,
          files: status.files,
        };
      }),
    );
    return withOverlaps(rows);
  }

  /** Rebases a finished worktree onto the latest default branch, pushes it and removes it. */
  async land(id: string): Promise<void> {
    const entry = await this.findIdle(id);
    await this.lock.run(entry.repoRoot, async () => {
      await this.deps.git.land(entry);
      await this.deps.git.remove(entry);
    });
    await this.forget(entry.id);
  }

  /** Throws a finished worktree away, edits, commits and all. */
  async discard(id: string): Promise<void> {
    const entry = await this.findIdle(id);
    await this.lock.run(entry.repoRoot, async () => this.deps.git.remove(entry));
    await this.forget(entry.id);
  }

  private held(entry: WorktreeEntry): boolean {
    return entry.holderPid !== null && this.deps.isAlive(entry.holderPid);
  }

  private inUse(entry: WorktreeEntry, live: readonly string[]): boolean {
    return this.held(entry) || live.some((cwd) => isInside(cwd, entry.path));
  }

  private async tidy(entry: WorktreeEntry, live: readonly string[]): Promise<WorktreeState> {
    if (this.inUse(entry, live)) {
      return 'active';
    }
    const status = await this.deps.git.status(entry);
    const state = stateOf(false, status);
    if (state === 'missing') {
      // The folder is gone, but its branch may still hold commits, so only the record goes.
      await this.deps.exec('git', ['worktree', 'prune'], { cwd: entry.repoRoot });
      await this.forget(entry.id);
    } else if (state === 'landed') {
      await this.lock.run(entry.repoRoot, async () => this.deps.git.remove(entry));
      await this.forget(entry.id);
    }
    return state;
  }

  private async findOrNull(id: string): Promise<WorktreeEntry | null> {
    const entries = await this.entries();
    return entries.find((entry) => entry.id === id) ?? null;
  }

  private async find(id: string): Promise<WorktreeEntry> {
    const entry = await this.findOrNull(id);
    if (entry === null) {
      throw new Error(`Overlord has no worktree ${id}.`);
    }
    return entry;
  }

  private async findIdle(id: string): Promise<WorktreeEntry> {
    const entry = await this.find(id);
    if (this.inUse(entry, await this.deps.liveCwds())) {
      throw new Error(`A session is still working in ${entry.path}.`);
    }
    return entry;
  }

  private fileFor(id: string): string {
    return path.join(this.deps.dir, `${id}.json`);
  }

  private async save(entry: WorktreeEntry): Promise<void> {
    await writeFileAtomic({
      target: this.fileFor(entry.id),
      content: `${JSON.stringify(entry, null, 2)}\n`,
      backup: null,
    });
  }

  private async forget(id: string): Promise<void> {
    await rm(this.fileFor(id), { force: true });
  }

  private async rememberRepo(repoRoot: string): Promise<void> {
    await this.load();
    const folder = repoFolder(repoRoot);
    if (this.repos[folder] === repoRoot) {
      return;
    }
    this.repos = { ...this.repos, [folder]: repoRoot };
    await mkdir(this.deps.dir, { recursive: true });
    await writeFileAtomic({
      target: path.join(this.deps.dir, REPOS_FILE),
      content: `${JSON.stringify(this.repos, null, 2)}\n`,
      backup: null,
    });
  }
}
