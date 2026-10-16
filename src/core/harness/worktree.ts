// Git worktrees for batch runs, so parallel agents do not stomp on each
// other. Each run gets <repoRoot>/.claude/worktrees/overlord-<runId> on a new
// branch overlord/<runId> from HEAD. All git calls go through an injected exec
// so the manager is easy to test.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command and rejects when it exits non-zero. */
export type ExecFunction = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<ExecResult>;

export interface WorktreeInfo {
  readonly runId: string;
  readonly repoRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
}

export interface ListedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly head: string;
}

export interface WorktreeDiff {
  readonly stat: string;
  readonly patch: string;
}

const BRANCH_PREFIX = 'overlord/';
const RUN_ID_PATTERN = /^[\w-]+$/;
// Variables a git hook sets that would point git at the wrong repository.
const GIT_LOCATION_VARS: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
]);

const execFileAsync = promisify(execFile);

export const nodeExec: ExecFunction = async (command, args, options) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !GIT_LOCATION_VARS.has(name)),
  );
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    cwd: options.cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
};

export function parseWorktreeList(porcelain: string): ListedWorktree[] {
  const listed: ListedWorktree[] = [];
  for (const block of porcelain.split('\n\n')) {
    let worktreePath = '';
    let head = '';
    let branch = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length);
      }
    }
    if (branch.startsWith(BRANCH_PREFIX)) {
      listed.push({ path: worktreePath, branch, head });
    }
  }
  return listed;
}

export class WorktreeManager {
  private readonly exec: ExecFunction;

  constructor(exec: ExecFunction = nodeExec) {
    this.exec = exec;
  }

  /** The repository root for cwd. Throws when cwd is not inside a git repository. */
  async repoRoot(cwd: string): Promise<string> {
    try {
      const { stdout } = await this.git(cwd, ['rev-parse', '--show-toplevel']);
      return stdout.trim();
    } catch {
      throw new Error(`${cwd} is not inside a git repository`);
    }
  }

  async create(cwd: string, runId: string): Promise<WorktreeInfo> {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`Run id "${runId}" may only hold letters, digits, _ and -`);
    }
    const repoRoot = await this.repoRoot(cwd);
    const head = await this.git(repoRoot, ['rev-parse', 'HEAD']);
    const baseCommit = head.stdout.trim();
    const worktreePath = path.join(repoRoot, '.claude', 'worktrees', `overlord-${runId}`);
    const branch = `${BRANCH_PREFIX}${runId}`;
    await this.git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
    return { runId, repoRoot, path: worktreePath, branch, baseCommit };
  }

  /** Overlord's worktrees in the repository that holds cwd. */
  async list(cwd: string): Promise<ListedWorktree[]> {
    const repoRoot = await this.repoRoot(cwd);
    const { stdout } = await this.git(repoRoot, ['worktree', 'list', '--porcelain']);
    return parseWorktreeList(stdout);
  }

  /**
   * Everything the run changed since the base commit, committed or not. New
   * files are marked intent-to-add first so they show up in the diff.
   */
  async diff(worktree: WorktreeInfo): Promise<WorktreeDiff> {
    await this.git(worktree.path, ['add', '--all', '--intent-to-add']);
    const stat = await this.git(worktree.path, ['diff', '--stat', worktree.baseCommit]);
    const patch = await this.git(worktree.path, ['diff', worktree.baseCommit]);
    return { stat: stat.stdout, patch: patch.stdout };
  }

  async remove(worktree: WorktreeInfo): Promise<void> {
    await this.git(worktree.repoRoot, ['worktree', 'remove', '--force', worktree.path]);
    await this.git(worktree.repoRoot, ['branch', '-D', worktree.branch]);
  }

  private async git(cwd: string, args: readonly string[]): Promise<ExecResult> {
    return this.exec('git', args, { cwd });
  }
}
