// Where each session works and what the others in its repository are
// changing. A workspace is one working tree: an Overlord worktree, one of
// Claude Code's own worktrees, or the repository's main checkout. Overlord
// worktrees know their changed files from git, and every workspace also
// counts the files its sessions edited since, so a fresh edit shows at once.

import path from 'node:path';

import type { WorktreeState, WorktreeSummary } from '../../shared/protocol.js';

export interface TrackedSession {
  readonly sessionId: string;
  readonly cwd: string;
  /** What the session is working on, from its title or first prompt, or null when unknown. */
  readonly topic: string | null;
  /** Busy, idle or waiting, as Claude Code reports it, or null. */
  readonly status: string | null;
  /** Absolute paths of the files the session edited. */
  readonly edited: readonly string[];
}

export interface Workspace {
  /** The worktree id, or the folder for a workspace Overlord did not make. */
  readonly key: string;
  readonly repoRoot: string;
  readonly root: string;
  readonly label: string;
  readonly branch: string | null;
  /** The branch work lands on, such as "master", or null when unknown. */
  readonly target: string | null;
  /** True while a session works in it, even one Overlord has not heard from yet. */
  readonly inUse: boolean;
  /** Changed files, relative to root. */
  readonly files: readonly string[];
  /** Changed files that the target has also changed since the workspace started. */
  readonly upstreamFiles: readonly string[];
  readonly sessions: readonly TrackedSession[];
}

// Claude Code's own worktrees sit at <repo>/.claude/worktrees/<name>.
const CLAUDE_WORKTREE = `${path.sep}.claude${path.sep}worktrees${path.sep}`;

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

/** Worktrees that still hold work, so landed and missing ones drop out. */
const HOLDS_WORK: ReadonlySet<WorktreeState> = new Set(['active', 'dirty', 'unlanded']);

function holdsWork(item: WorktreeSummary): boolean {
  return HOLDS_WORK.has(item.state);
}

function fromWorktree(item: WorktreeSummary): Workspace {
  return {
    key: item.id,
    repoRoot: item.repoRoot,
    root: item.path,
    label: item.label,
    branch: item.branch,
    target: item.target,
    inUse: item.state === 'active',
    files: item.files,
    upstreamFiles: item.upstreamFiles,
    sessions: [],
  };
}

/** The checkout a folder inside a repository sits in: one of Claude Code's worktrees, or the main one. */
function checkoutRoot(folder: string, repoRoot: string): string {
  const marker = folder.indexOf(CLAUDE_WORKTREE, repoRoot.length);
  if (marker === -1) {
    return repoRoot;
  }
  const nameEnd = folder.indexOf(path.sep, marker + CLAUDE_WORKTREE.length);
  return nameEnd === -1 ? folder : folder.slice(0, nameEnd);
}

/**
 * The workspace a folder belongs to, for repositories Overlord has made a
 * worktree in. Null for a folder in none of them.
 */
export function workspaceFor(
  folder: string,
  worktrees: readonly WorktreeSummary[],
): Workspace | null {
  const worktree = worktrees.find((item) => holdsWork(item) && isInside(folder, item.path));
  if (worktree !== undefined) {
    return fromWorktree(worktree);
  }
  const repo = worktrees.find((item) => isInside(folder, item.repoRoot));
  if (repo === undefined) {
    return null;
  }
  const root = checkoutRoot(folder, repo.repoRoot);
  return {
    key: root,
    repoRoot: repo.repoRoot,
    root,
    label: path.basename(root),
    branch: null,
    target: repo.target,
    inUse: true,
    files: [],
    upstreamFiles: [],
    sessions: [],
  };
}

function sorted(files: readonly string[]): string[] {
  return [...new Set(files)].toSorted((a, b) => a.localeCompare(b));
}

/** Every workspace that holds work or a session, with its sessions and their edits folded in. */
export function buildWorkspaces(
  worktrees: readonly WorktreeSummary[],
  sessions: readonly TrackedSession[],
): Workspace[] {
  const found = new Map<string, Workspace>();
  for (const item of worktrees.filter((candidate) => holdsWork(candidate))) {
    found.set(item.id, fromWorktree(item));
  }
  for (const session of sessions) {
    const place = workspaceFor(session.cwd, worktrees);
    if (place === null) {
      continue;
    }
    const current = found.get(place.key) ?? place;
    const edited = session.edited
      .filter((file) => isInside(file, current.root))
      .map((file) => path.relative(current.root, file));
    found.set(place.key, {
      ...current,
      inUse: true,
      files: sorted([...current.files, ...edited]),
      sessions: [...current.sessions, session],
    });
  }
  return [...found.values()];
}

/** The workspace that holds a file, preferring the deepest root. */
export function workspaceOfFile(
  file: string,
  workspaces: readonly Workspace[],
): Workspace | undefined {
  return workspaces
    .filter((item) => isInside(file, item.root))
    .toSorted((a, b) => b.root.length - a.root.length)[0];
}

/** The other workspaces of the same repository that hold a session or changes. */
export function peersOf(self: Workspace, workspaces: readonly Workspace[]): Workspace[] {
  return workspaces.filter(
    (item) =>
      item.key !== self.key &&
      item.repoRoot === self.repoRoot &&
      (item.inUse || item.files.length > 0),
  );
}
