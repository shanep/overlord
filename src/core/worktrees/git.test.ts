import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecResult } from '../sync/exec.js';

import {
  BRANCH_PREFIX,
  LandConflictError,
  NotARepoError,
  repoFolder,
  worktreeFolder,
  WorktreeGit,
  type WorktreeInfo,
} from './git.js';
import {
  commitFile,
  fail,
  failPrePush,
  git,
  type GitWorld,
  makeWorld,
  ok,
  scriptedExec,
  testExec,
} from './test-helpers/git-world.js';

let world: GitWorld;
let manager: WorktreeGit;

const INFO: WorktreeInfo = {
  id: 'w1',
  repoRoot: '/repo',
  path: '/wt/w1',
  branch: 'overlord/w1',
  baseCommit: 'base',
  target: 'main',
};

/** A WorktreeGit whose pushes fail with each stderr in turn, then succeed. */
function landing(pushes: readonly string[], calls: string[][]): WorktreeGit {
  let push = 0;
  return new WorktreeGit(
    scriptedExec(
      [
        (args): ExecResult | null => (args[0] === 'rev-parse' ? ok('true\n') : null),
        (args): ExecResult | null => (args[0] === 'rev-list' ? ok('1\n') : null),
        (args): ExecResult | null => (args[0] === 'merge-base' ? ok('base\n') : null),
        (args): ExecResult | null => {
          if (args[0] !== 'push') {
            return null;
          }
          const stderr = pushes[push] ?? '';
          push += 1;
          return stderr === '' ? ok() : fail(stderr);
        },
      ],
      calls,
    ),
    '/wt',
  );
}

describe('worktreeFolder', () => {
  it('names the folder after the repo plus the start of the id', () => {
    expect(worktreeFolder('/a/app', '9ddebe83-afe6-47df-9ebb-00702feb383e')).toBe('app-9ddebe83');
    expect(worktreeFolder('/a/app', 'w1')).toBe('app-w1');
  });
});

describe('repoFolder', () => {
  it('names the folder after the repo plus a stable hash of its path', () => {
    expect(repoFolder('/a/app')).toMatch(/^app-[\da-f]{8}$/u);
    expect(repoFolder('/a/app')).toBe(repoFolder('/a/app'));
    expect(repoFolder('/b/app')).not.toBe(repoFolder('/a/app'));
  });
});

// Each test runs real git many times, which takes far longer than usual on a busy machine.
describe('WorktreeGit', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    world = await makeWorld();
    manager = new WorktreeGit(testExec, world.root);
  });

  afterEach(async () => {
    await rm(world.dir, { recursive: true, force: true });
  });

  describe('WorktreeGit.repoRoot', () => {
    it('finds the main checkout from a subfolder and from inside a worktree', async () => {
      await mkdir(path.join(world.repo, 'sub'));
      expect(await manager.repoRoot(path.join(world.repo, 'sub'))).toBe(world.repo);
      const info = await manager.create(world.repo, 'w1');
      expect(await manager.repoRoot(info.path)).toBe(world.repo);
    });

    it('throws NotARepoError outside git', async () => {
      await expect(manager.repoRoot(world.dir)).rejects.toBeInstanceOf(NotARepoError);
      await expect(manager.repoRoot(world.dir)).rejects.toThrow(
        `${world.dir} is not inside a git repository`,
      );
    });

    it('uses the top level for a submodule and refuses empty output', async () => {
      const submodule = new WorktreeGit(
        scriptedExec([(): ExecResult => ok('/x/.git/modules/sub\n/x/sub\n')]),
        '/wt',
      );
      expect(await submodule.repoRoot('/x/sub')).toBe('/x/sub');
      const silent = new WorktreeGit(scriptedExec([(): ExecResult => ok('')]), '/wt');
      await expect(silent.repoRoot('/x')).rejects.toBeInstanceOf(NotARepoError);
    });
  });

  describe('WorktreeGit.defaultBranch', () => {
    it('follows origin/HEAD, then main, then master, else null', async () => {
      expect(await manager.defaultBranch(world.repo)).toBe('main');
      await git(world.repo, 'remote', 'set-head', 'origin', '-d');
      expect(await manager.defaultBranch(world.repo)).toBe('main');
      await git(world.repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
      await git(world.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
      expect(await manager.defaultBranch(world.repo)).toBe('master');
      await git(world.repo, 'remote', 'remove', 'origin');
      expect(await manager.defaultBranch(world.repo)).toBeNull();
    });

    it('ignores an origin/HEAD that names something odd', async () => {
      const odd = new WorktreeGit(
        scriptedExec([
          (args): ExecResult | null =>
            args.includes('refs/remotes/origin/HEAD') ? ok('upstream/main\n') : null,
          (): ExecResult => fail(),
        ]),
        '/wt',
      );
      expect(await odd.defaultBranch('/repo')).toBeNull();
    });
  });

  describe('WorktreeGit.create', () => {
    it('starts from the freshly fetched default branch, outside the repo', async () => {
      const landed = await commitFile(world.other, 'b.txt', 'two\n');
      await git(world.other, 'push', '-q', 'origin', 'main');
      const info = await manager.create(world.repo, 'w1');
      expect(info).toStrictEqual({
        id: 'w1',
        repoRoot: world.repo,
        path: path.join(world.root, repoFolder(world.repo), worktreeFolder(world.repo, 'w1')),
        branch: `${BRANCH_PREFIX}w1`,
        baseCommit: landed,
        target: 'main',
      });
      expect(existsSync(path.join(info.path, 'b.txt'))).toBe(true);
      expect(await git(info.path, 'branch', '--show-current')).toBe('overlord/w1');
    });

    it('uses the last fetched branch offline and HEAD without an origin', async () => {
      const fetched = await git(world.repo, 'rev-parse', 'origin/main');
      await git(world.repo, 'remote', 'set-url', 'origin', path.join(world.dir, 'nowhere'));
      const offline = await manager.create(world.repo, 'offline');
      expect(offline).toMatchObject({ baseCommit: fetched, target: 'main' });
      const head = await commitFile(world.repo, 'local.txt', 'local\n');
      await git(world.repo, 'remote', 'remove', 'origin');
      const local = await manager.create(world.repo, 'local');
      expect(local).toMatchObject({ baseCommit: head, target: null });
    });

    it('refuses ids that could leave the worktree folder', async () => {
      await expect(manager.create(world.repo, '../evil')).rejects.toThrow(
        'Worktree id "../evil" may only hold letters, digits, _ and -',
      );
      await expect(manager.create(world.repo, '')).rejects.toThrow('may only hold');
    });

    it('names the failing git command when git says nothing', async () => {
      const quiet = new WorktreeGit(
        scriptedExec([
          (args): ExecResult | null =>
            args[0] === 'rev-parse' && args[1] === '--path-format=absolute'
              ? ok('/r/.git\n/r\n')
              : null,
          (args): ExecResult | null => (args[0] === 'worktree' ? fail() : null),
          (args): ExecResult | null => (args[0] === 'rev-parse' ? ok('abc\n') : null),
          (): ExecResult => fail(),
        ]),
        '/wt',
      );
      await expect(quiet.create('/r', 'w1')).rejects.toThrow(/^git worktree failed$/u);
      await expect(manager.create(world.repo, 'same')).resolves.toMatchObject({ id: 'same' });
      await expect(manager.create(world.repo, 'same')).rejects.toThrow(
        /^git worktree failed: .*already exists/su,
      );
    });
  });

  describe('WorktreeGit.restore', () => {
    it('brings back the old branch when it is still around, else starts a new one', async () => {
      const made = await manager.create(world.repo, 'keep-1234');
      const mine = await commitFile(made.path, 'c.txt', 'mine\n');
      await rm(made.path, { recursive: true, force: true });
      const kept = await manager.restore(world.repo, made.path, 'unused');
      expect(kept).toStrictEqual({ ...made, id: 'keep-1234' });
      expect(await git(kept.path, 'rev-parse', 'HEAD')).toBe(mine);

      await manager.remove(kept);
      const fresh = await manager.restore(world.repo, made.path, 'new-1');
      expect(fresh).toMatchObject({ id: 'new-1', path: made.path, branch: 'overlord/new-1' });
      expect(await git(fresh.path, 'branch', '--show-current')).toBe('overlord/new-1');
    });

    it('refuses a folder that is not named like one of its worktrees', async () => {
      await expect(manager.restore(world.repo, '/wt/x/other', 'w1')).rejects.toThrow(
        '/wt/x/other is not where an Overlord worktree lives',
      );
      await expect(manager.restore(world.repo, '/wt/x/repo-ok', '../evil')).rejects.toThrow(
        'is not where',
      );
    });
  });

  describe('WorktreeGit.behind and update', () => {
    it('count and take in what landed upstream, and refuse without an origin or a worktree', async () => {
      const info = await manager.create(world.repo, 'w1');
      expect(await manager.behind(info)).toBe(0);
      await commitFile(world.other, 'b.txt', 'two\n');
      await git(world.other, 'push', '-q', 'origin', 'main');
      expect(await manager.behind(info)).toBe(1);
      await manager.update(info);
      expect(await manager.behind(info)).toBe(0);
      expect(existsSync(path.join(info.path, 'b.txt'))).toBe(true);

      const local = { ...info, target: null };
      expect(await manager.behind(local)).toBe(0);
      await expect(manager.update(local)).rejects.toThrow('has no origin branch to update from');
      const gone = { ...info, path: path.join(world.dir, 'gone') };
      expect(await manager.behind(gone)).toBe(0);
      await expect(manager.update(gone)).rejects.toThrow('is gone');
      await writeFile(path.join(info.path, 'a.txt'), 'edited\n');
      await expect(manager.update(info)).rejects.toThrow('uncommitted changes');
    });
  });

  describe('WorktreeGit.status', () => {
    it('counts edits, commits and changed files', async () => {
      const info = await manager.create(world.repo, 'w1');
      expect(await manager.status(info)).toStrictEqual({
        exists: true,
        dirty: 0,
        ahead: 0,
        files: [],
        upstreamFiles: [],
      });
      await writeFile(path.join(info.path, 'a.txt'), 'edited\n');
      await writeFile(path.join(info.path, 'new.txt'), 'new\n');
      expect(await manager.status(info)).toStrictEqual({
        exists: true,
        dirty: 2,
        ahead: 0,
        files: ['a.txt', 'new.txt'],
        upstreamFiles: [],
      });
      await git(info.path, 'add', '-A');
      await git(info.path, 'commit', '-q', '-m', 'work');
      expect(await manager.status(info)).toStrictEqual({
        exists: true,
        dirty: 0,
        ahead: 1,
        files: ['a.txt', 'new.txt'],
        upstreamFiles: [],
      });
    });

    it('names the changed files the default branch has also changed since the branch started', async () => {
      const info = await manager.create(world.repo, 'w1');
      await commitFile(info.path, 'mine.txt', 'mine\n');
      await writeFile(path.join(info.path, 'a.txt'), 'edited here\n');
      await commitFile(world.other, 'a.txt', 'theirs\n');
      await commitFile(world.other, 'theirs.txt', 'theirs\n');
      await git(world.other, 'push', '-q', 'origin', 'main');
      expect(await manager.status(info)).toMatchObject({ upstreamFiles: [] });
      await git(world.repo, 'fetch', '-q', 'origin', 'main');
      expect(await manager.status(info)).toMatchObject({
        files: ['a.txt', 'mine.txt'],
        upstreamFiles: ['a.txt'],
      });
    });

    it('counts from the base commit when there is no origin or its branch is gone', async () => {
      const tracked = await manager.create(world.repo, 'tracked');
      await commitFile(tracked.path, 'd.txt', 'four\n');
      await git(world.repo, 'remote', 'remove', 'origin');
      expect(await manager.status(tracked)).toMatchObject({ ahead: 1, files: ['d.txt'] });
      const info = await manager.create(world.repo, 'w1');
      await commitFile(info.path, 'c.txt', 'three\n');
      expect(await manager.status(info)).toMatchObject({ ahead: 1, files: ['c.txt'] });
    });

    it('reports a worktree removed while it is being read as gone', async () => {
      const info = await manager.create(world.repo, 'w1');
      const racing = new WorktreeGit(async (command, args, options) => {
        if (args[0] === 'ls-files') {
          await rm(info.path, { recursive: true, force: true });
        }
        return testExec(command, args, options);
      }, path.dirname(info.path));
      expect(await racing.status(info)).toMatchObject({ exists: false, files: [] });
    });

    it('still fails a read that fails on a worktree that is there', async () => {
      const info = await manager.create(world.repo, 'w1');
      const broken = new WorktreeGit(
        async (command, args, options) =>
          args[0] === 'ls-files' ? fail('index is locked') : testExec(command, args, options),
        path.dirname(info.path),
      );
      await expect(broken.status(info)).rejects.toThrow('git ls-files failed: index is locked');
    });

    it('reports a worktree whose folder is gone', async () => {
      const info = await manager.create(world.repo, 'w1');
      await rm(info.path, { recursive: true, force: true });
      expect(await manager.status(info)).toStrictEqual({
        exists: false,
        dirty: 0,
        ahead: 0,
        files: [],
        upstreamFiles: [],
      });
    });
  });

  describe('WorktreeGit.land', () => {
    it('rebases onto work another session landed first, then pushes', async () => {
      const info = await manager.create(world.repo, 'w1');
      await commitFile(info.path, 'mine.txt', 'mine\n');
      await commitFile(world.other, 'theirs.txt', 'theirs\n');
      await git(world.other, 'push', '-q', 'origin', 'main');
      await manager.land(info);
      const files = await git(world.origin, 'ls-tree', '--name-only', 'main');
      expect(files.split('\n')).toStrictEqual(['a.txt', 'mine.txt', 'theirs.txt']);
      expect(await manager.status(info)).toMatchObject({ dirty: 0, ahead: 0 });
    });

    it('stops on a conflict and leaves the branch as it was', async () => {
      const info = await manager.create(world.repo, 'w1');
      const mine = await commitFile(info.path, 'a.txt', 'mine\n');
      await commitFile(world.other, 'a.txt', 'theirs\n');
      await git(world.other, 'push', '-q', 'origin', 'main');
      const error: unknown = await manager.land(info).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(LandConflictError);
      expect(error).toMatchObject({
        files: ['a.txt'],
        message: 'The rebase onto the latest default branch conflicts in a.txt.',
      });
      expect(await git(info.path, 'rev-parse', 'HEAD')).toBe(mine);
      expect(await git(info.path, 'status', '--porcelain')).toBe('');
    });

    it('refuses to land with nowhere to go, no folder or uncommitted edits', async () => {
      const info = await manager.create(world.repo, 'w1');
      await expect(manager.land({ ...info, target: null })).rejects.toThrow(
        `${world.repo} has no origin branch to land on.`,
      );
      await writeFile(path.join(info.path, 'a.txt'), 'edited\n');
      await expect(manager.land(info)).rejects.toThrow('The worktree has uncommitted changes.');
      await rm(info.path, { recursive: true, force: true });
      await expect(manager.land(info)).rejects.toThrow(`The worktree at ${info.path} is gone.`);
    });

    it('gives up at once when the push fails for another reason', async () => {
      const info = await manager.create(world.repo, 'w1');
      await commitFile(info.path, 'mine.txt', 'mine\n');
      await failPrePush(world.repo);
      await expect(manager.land(info)).rejects.toThrow(/git push failed: .*checks failed/su);
    });

    it('tries again while the push is only behind, up to three times', async () => {
      const behind = ' ! [rejected]        HEAD -> main (fetch first)';
      const calls: string[][] = [];
      await landing([behind, behind, ''], calls).land(INFO);
      expect(calls.filter((args) => args[0] === 'rebase')).toHaveLength(3);
      const stuck = landing([behind, behind, ' ! [rejected] HEAD -> main (non-fast-forward)'], []);
      await expect(stuck.land(INFO)).rejects.toThrow('non-fast-forward');
    });

    it('reports a rebase that fails without conflicted files', async () => {
      const broken = new WorktreeGit(
        scriptedExec([
          (args): ExecResult | null => (args[0] === 'rev-parse' ? ok('true\n') : null),
          (args): ExecResult | null => (args[0] === 'rev-list' ? ok('1\n') : null),
          (args): ExecResult | null => (args[0] === 'merge-base' ? ok('base\n') : null),
          (args): ExecResult | null =>
            args[0] === 'rebase' && args[1] !== '--abort' ? fail('boom') : null,
        ]),
        '/wt',
      );
      await expect(broken.land(INFO)).rejects.toThrow(
        'The rebase onto the latest default branch failed.',
      );
    });
  });

  describe('WorktreeGit.remove', () => {
    it('deletes the folder and the branch, and shrugs off parts already gone', async () => {
      const info = await manager.create(world.repo, 'w1');
      await manager.remove(info);
      expect(existsSync(info.path)).toBe(false);
      expect(await git(world.repo, 'branch', '--list', info.branch)).toBe('');
      await expect(manager.remove(info)).resolves.toBeUndefined();
    });
  });
});
