// Git operations on Overlord's worktrees. Each one lives outside the
// repository, under <root>/<repo>-<hash>/<repo>-<short id>, on a branch overlord/<id>
// started from a freshly fetched default branch. Keeping them out of the repo
// means linters, test runners and file watchers in the main checkout never
// see them. Every git call goes through an injected Exec so tests can fake it.

import { createHash } from 'node:crypto';
import path from 'node:path';

import type { Exec, ExecResult } from '../sync/exec.js';

export interface WorktreeInfo {
  readonly id: string;
  /** The main checkout of the repository, even when created from inside another worktree. */
  readonly repoRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  /** The origin branch work lands on, such as "master", or null when the repo has no origin. */
  readonly target: string | null;
}

export interface WorktreeStatus {
  readonly exists: boolean;
  /** Files with uncommitted changes. */
  readonly dirty: number;
  /** Commits on the branch that the origin target does not have. */
  readonly ahead: number;
  /** Files changed on this branch, committed or not. */
  readonly files: readonly string[];
  /**
   * Files in `files` that the origin target has also changed since this
   * branch started, so rebasing onto it may conflict in them.
   */
  readonly upstreamFiles: readonly string[];
}

export class NotARepoError extends Error {
  constructor(cwd: string) {
    super(`${cwd} is not inside a git repository`);
    this.name = 'NotARepoError';
  }
}

export class LandConflictError extends Error {
  constructor(readonly files: readonly string[]) {
    super(
      files.length === 0
        ? 'The rebase onto the latest default branch failed.'
        : `The rebase onto the latest default branch conflicts in ${files.join(', ')}.`,
    );
    this.name = 'LandConflictError';
  }
}

export const BRANCH_PREFIX = 'overlord/';
const ID_PATTERN = /^[\w-]+$/u;
const PUSH_ATTEMPTS = 3;
const SLOW_TIMEOUT_MS = 15 * 60_000;
// Push output when another session landed first and a rebase would fix it.
const BEHIND_PATTERN = /\(fetch first\)|non-fast-forward/u;

/** A worktree that is gone, so there is nothing to land and nothing left to keep. */
const MISSING: WorktreeStatus = {
  exists: false,
  dirty: 0,
  ahead: 0,
  files: [],
  upstreamFiles: [],
};

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

/** The folder a repository's worktrees share: its name plus a short hash of its path. */
export function repoFolder(repoRoot: string): string {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  return `${path.basename(repoRoot)}-${hash}`;
}

/** Characters of the id a worktree's folder keeps, like the short ids Claude Code shows. */
const SHORT_ID_CHARS = 8;

/**
 * The worktree's own folder: the repo name plus the start of its id, such as
 * "overlord-9ddebe83". VS Code shows this folder beside a terminal tab's
 * title, where a bare uuid says nothing.
 */
export function worktreeFolder(repoRoot: string, id: string): string {
  return `${path.basename(repoRoot)}-${id.slice(0, SHORT_ID_CHARS)}`;
}

export class WorktreeGit {
  private readonly exec: Exec;

  constructor(
    exec: Exec,
    /** Where worktrees go, such as ~/.overlord/worktrees. */
    private readonly root: string,
  ) {
    // Overlord reads status while agents commit in the same worktree. A plain
    // `git status` briefly takes the index lock to refresh it, and an agent's
    // commit landing at that moment fails, so Overlord skips optional locks.
    this.exec = async (command, args, options): Promise<ExecResult> =>
      exec(command, args, { ...options, env: { ...options.env, GIT_OPTIONAL_LOCKS: '0' } });
  }

  /** The main checkout for cwd. Throws when cwd is not inside a git repository. */
  async repoRoot(cwd: string): Promise<string> {
    const result = await this.exec(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
      { cwd },
    );
    const [commonDir, topLevel] = lines(result.stdout);
    if (result.code !== 0 || commonDir === undefined || topLevel === undefined) {
      throw new NotARepoError(cwd);
    }
    // A submodule keeps its git dir under the parent's .git/modules, so only
    // a common dir named .git points at the main checkout.
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : topLevel;
  }

  /**
   * The branch origin/HEAD points to, else main or master when origin has
   * one, else null. A branch only counts when its origin copy exists.
   */
  async defaultBranch(repoRoot: string): Promise<string | null> {
    const head = await this.exec(
      'git',
      ['rev-parse', '--verify', '--quiet', '--abbrev-ref', 'refs/remotes/origin/HEAD'],
      { cwd: repoRoot },
    );
    const named = head.stdout.trim();
    if (head.code === 0 && named.startsWith('origin/')) {
      return named.slice('origin/'.length);
    }
    for (const candidate of ['main', 'master']) {
      const found = await this.exec(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`],
        { cwd: repoRoot },
      );
      if (found.code === 0) {
        return candidate;
      }
    }
    return null;
  }

  async create(cwd: string, id: string): Promise<WorktreeInfo> {
    if (!ID_PATTERN.test(id)) {
      throw new Error(`Worktree id "${id}" may only hold letters, digits, _ and -`);
    }
    const repoRoot = await this.repoRoot(cwd);
    const target = await this.defaultBranch(repoRoot);
    if (target !== null) {
      // Offline is fine: the last fetched copy of the branch still works.
      await this.exec('git', ['fetch', '--quiet', 'origin', target], { cwd: repoRoot });
    }
    const baseCommit = await this.baseCommit(repoRoot, target);
    const worktreePath = path.join(this.root, repoFolder(repoRoot), worktreeFolder(repoRoot, id));
    const branch = `${BRANCH_PREFIX}${id}`;
    await this.git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
    return { id, repoRoot, path: worktreePath, branch, baseCommit, target };
  }

  /**
   * Makes a worktree again at the path a removed one had, so a session that
   * ran there can resume. Its old branch comes back when it is still around,
   * and otherwise a new branch overlord/<id> starts from the default branch.
   */
  async restore(repoRoot: string, worktreePath: string, id: string): Promise<WorktreeInfo> {
    const short = path.basename(worktreePath).slice(path.basename(repoRoot).length + 1);
    if (!ID_PATTERN.test(id) || !ID_PATTERN.test(short)) {
      throw new Error(`${worktreePath} is not where an Overlord worktree lives`);
    }
    // A record git still keeps for the old folder blocks a new worktree there.
    await this.exec('git', ['worktree', 'prune'], { cwd: repoRoot });
    const target = await this.defaultBranch(repoRoot);
    if (target !== null) {
      await this.exec('git', ['fetch', '--quiet', 'origin', target], { cwd: repoRoot });
    }
    const base = await this.baseCommit(repoRoot, target);
    const kept = lines(
      await this.git(repoRoot, [
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/heads/${BRANCH_PREFIX}${short}*`,
      ]),
    );
    const [branch] = kept;
    if (kept.length === 1 && branch !== undefined) {
      await this.git(repoRoot, ['worktree', 'add', worktreePath, branch]);
      const merged = await this.git(repoRoot, ['merge-base', branch, base]);
      const baseCommit = merged.trim();
      const keptId = branch.slice(BRANCH_PREFIX.length);
      return { id: keptId, repoRoot, path: worktreePath, branch, baseCommit, target };
    }
    const fresh = `${BRANCH_PREFIX}${id}`;
    await this.git(repoRoot, ['worktree', 'add', '-b', fresh, worktreePath, base]);
    return { id, repoRoot, path: worktreePath, branch: fresh, baseCommit: base, target };
  }

  async status(info: WorktreeInfo): Promise<WorktreeStatus> {
    const probe = await this.exec('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: info.path,
    });
    if (probe.code !== 0) {
      return MISSING;
    }
    const porcelain = await this.git(info.path, ['status', '--porcelain']);
    const upstream = await this.upstream(info);
    const since = upstream === null ? info.baseCommit : await this.mergeBase(info.path, upstream);
    const ahead = await this.git(info.path, ['rev-list', '--count', `${upstream ?? since}..HEAD`]);
    const changed = await this.git(info.path, ['diff', '--name-only', since]);
    const untracked = await this.git(info.path, ['ls-files', '--others', '--exclude-standard']);
    const files = [...new Set([...lines(changed), ...lines(untracked)])].toSorted((a, b) =>
      a.localeCompare(b),
    );
    const landed =
      upstream === null
        ? new Set<string>()
        : new Set(lines(await this.git(info.path, ['diff', '--name-only', since, upstream])));
    return {
      exists: true,
      dirty: lines(porcelain).length,
      ahead: Number(ahead.trim()),
      files,
      upstreamFiles: files.filter((file) => landed.has(file)),
    };
  }

  /**
   * Rebases the branch onto the latest target and pushes it there. Another
   * session landing first only means another fetch and rebase, so a push that
   * is merely behind gets a few more tries.
   */
  async land(info: WorktreeInfo): Promise<void> {
    if (info.target === null) {
      throw new Error(`${info.repoRoot} has no origin branch to land on.`);
    }
    const status = await this.status(info);
    if (!status.exists) {
      throw new Error(`The worktree at ${info.path} is gone.`);
    }
    if (status.dirty > 0) {
      throw new Error('The worktree has uncommitted changes. Commit or discard them first.');
    }
    for (let attempt = 1; ; attempt += 1) {
      await this.git(info.path, ['fetch', '--quiet', 'origin', info.target]);
      await this.rebase(info.path, `origin/${info.target}`);
      const push = await this.exec('git', ['push', 'origin', `HEAD:refs/heads/${info.target}`], {
        cwd: info.path,
        timeoutMs: SLOW_TIMEOUT_MS,
      });
      if (push.code === 0) {
        return;
      }
      if (attempt >= PUSH_ATTEMPTS || !BEHIND_PATTERN.test(push.stderr)) {
        throw new Error(`git push failed: ${push.stderr.trim()}`);
      }
    }
  }

  /**
   * How many commits the latest target has that the branch does not, after a
   * fetch. Zero offline, with no origin, or when the worktree is gone.
   */
  async behind(info: WorktreeInfo): Promise<number> {
    if (info.target === null) {
      return 0;
    }
    await this.exec('git', ['fetch', '--quiet', 'origin', info.target], { cwd: info.path });
    const count = await this.exec('git', ['rev-list', '--count', `HEAD..origin/${info.target}`], {
      cwd: info.path,
    });
    return count.code === 0 ? Number(count.stdout.trim()) : 0;
  }

  /** Rebases the branch onto the latest target without pushing, so its session works on current code. */
  async update(info: WorktreeInfo): Promise<void> {
    if (info.target === null) {
      throw new Error(`${info.repoRoot} has no origin branch to update from.`);
    }
    const status = await this.status(info);
    if (!status.exists) {
      throw new Error(`The worktree at ${info.path} is gone.`);
    }
    if (status.dirty > 0) {
      throw new Error('The worktree has uncommitted changes. Commit or discard them first.');
    }
    await this.git(info.path, ['fetch', '--quiet', 'origin', info.target]);
    await this.rebase(info.path, `origin/${info.target}`);
  }

  /** Deletes the worktree and its branch. Parts that are already gone are skipped. */
  async remove(info: WorktreeInfo): Promise<void> {
    await this.exec('git', ['worktree', 'remove', '--force', info.path], { cwd: info.repoRoot });
    await this.exec('git', ['worktree', 'prune'], { cwd: info.repoRoot });
    await this.exec('git', ['branch', '-D', info.branch], { cwd: info.repoRoot });
  }

  private async baseCommit(repoRoot: string, target: string | null): Promise<string> {
    const ref = target === null ? 'HEAD' : `origin/${target}`;
    const commit = await this.git(repoRoot, ['rev-parse', `${ref}^{commit}`]);
    return commit.trim();
  }

  /** The origin branch to compare with, or null when there is none to fall back on the base. */
  private async upstream(info: WorktreeInfo): Promise<string | null> {
    if (info.target === null) {
      return null;
    }
    const upstream = `origin/${info.target}`;
    const found = await this.exec('git', ['rev-parse', '--verify', '--quiet', upstream], {
      cwd: info.path,
    });
    return found.code === 0 ? upstream : null;
  }

  private async mergeBase(cwd: string, upstream: string): Promise<string> {
    const base = await this.git(cwd, ['merge-base', 'HEAD', upstream]);
    return base.trim();
  }

  private async rebase(cwd: string, onto: string): Promise<void> {
    const result = await this.exec('git', ['rebase', onto], { cwd });
    if (result.code === 0) {
      return;
    }
    const conflicts = await this.exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd });
    await this.exec('git', ['rebase', '--abort'], { cwd });
    throw new LandConflictError(lines(conflicts.stdout));
  }

  private async git(cwd: string, args: readonly [string, ...string[]]): Promise<string> {
    const result = await this.exec('git', args, { cwd });
    if (result.code !== 0) {
      const detail = result.stderr.trim();
      const suffix = detail === '' ? '' : `: ${detail}`;
      throw new Error(`git ${args[0]} failed${suffix}`);
    }
    return result.stdout;
  }
}
