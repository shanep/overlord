// What the launcher's Worktrees table shows about each worktree Overlord made.

/**
 * Where a worktree stands. Active ones have a session working in them. The
 * rest are finished: dirty ones hold uncommitted edits, unlanded ones hold
 * commits the default branch does not have, landed ones are about to go.
 */
export type WorktreeState = 'active' | 'dirty' | 'unlanded' | 'landed' | 'missing';

export interface WorktreeOverlap {
  readonly id: string;
  readonly label: string;
  readonly files: readonly string[];
}

export interface WorktreeSummary {
  readonly id: string;
  readonly kind: 'run' | 'session';
  readonly label: string;
  readonly repoRoot: string;
  readonly path: string;
  readonly branch: string;
  /** The origin branch work lands on, or null when the repository has no origin. */
  readonly target: string | null;
  readonly slot: number;
  readonly createdAt: number;
  readonly state: WorktreeState;
  readonly ahead: number;
  readonly dirty: number;
  /** Changed files, then the ones the default branch also changed since this worktree started. */
  readonly files: readonly string[];
  readonly upstreamFiles: readonly string[];
  /** Other worktrees of the same repository changing some of the same files. */
  readonly overlaps: readonly WorktreeOverlap[];
}
