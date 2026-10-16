import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repoFolder, WorktreeGit } from './git.js';
import {
  freeSlot,
  type Lease,
  PORT_BASE,
  PORT_STEP,
  projectFolder,
  WorktreeRegistry,
  worktreeEnv,
} from './registry.js';
import { SETUP_SCRIPT } from './setup.js';
import { commitFile, git, type GitWorld, makeWorld, testExec } from './test-helpers/git-world.js';

const ME = 100;
const OTHER_WINDOW = 200;

let world: GitWorld;
let dir: string;
let alive: Set<number>;
let live: string[];
let now: number;
/** Setups the leases started. Each test's folder goes only after they finish, or rm races them. */
const setups: Promise<unknown>[] = [];

function registry(pid = ME): WorktreeRegistry {
  const reg = new WorktreeRegistry({
    git: new WorktreeGit(testExec, world.root),
    exec: testExec,
    dir,
    root: world.root,
    pid,
    isAlive: (candidate): boolean => alive.has(candidate),
    clock: (): number => (now += 1),
    liveCwds: async (): Promise<readonly string[]> => {
      await Promise.resolve();
      return live;
    },
  });
  const acquire = reg.acquire.bind(reg);
  reg.acquire = async (request): Promise<Lease> => {
    const lease = await acquire(request);
    setups.push(lease.ready);
    return lease;
  };
  return reg;
}

describe('helpers', () => {
  it('hands out the smallest free slot and ports from it', () => {
    expect(freeSlot([])).toBe(0);
    expect(freeSlot([0, 1, 3])).toBe(2);

    expect(worktreeEnv({ id: 'w1', slot: 2 })).toStrictEqual({
      OVERLORD_WORKTREE_ID: 'w1',
      OVERLORD_SLOT: '2',
      OVERLORD_PORT_BASE: String(PORT_BASE + 2 * PORT_STEP),
    });
  });

  it('maps worktree folders back to their repository', () => {
    const repos = { 'app-1234abcd': '/src/app' };
    expect(projectFolder('/wt/app-1234abcd/w1', '/wt', repos)).toBe('/src/app');
    expect(projectFolder('/wt/app-1234abcd/w1/src', '/wt', repos)).toBe('/src/app');
    expect(projectFolder('/wt/unknown-00000000/w1', '/wt', repos)).toBe('/wt/unknown-00000000/w1');
    expect(projectFolder('/src/app/.claude/worktrees/fix', '/wt', repos)).toBe('/src/app');
    expect(projectFolder('/src/app', '/wt', repos)).toBe('/src/app');
  });
});

// Each test runs real git many times, which takes far longer than usual on a busy machine.
describe('registry with git', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    world = await makeWorld();
    dir = path.join(world.dir, 'storage', 'worktrees');
    alive = new Set([ME]);
    live = [];
    now = 1000;
  });

  afterEach(async () => {
    await Promise.allSettled(setups.splice(0));
    await rm(world.dir, { recursive: true, force: true });
  });

  describe('WorktreeRegistry', () => {
    it('acquires a set-up worktree, records it and remembers its repository', async () => {
      await commitFile(world.other, SETUP_SCRIPT.replace('.overlord/', ''), 'unused\n');
      await mkdir(path.join(world.other, '.overlord'));
      await writeFile(path.join(world.other, SETUP_SCRIPT), 'echo "$OVERLORD_SLOT" > slot.txt\n');
      await git(world.other, 'add', '.');
      await git(world.other, 'commit', '-q', '-m', 'setup');
      await git(world.other, 'push', '-q', 'origin', 'main');
      const first = registry();
      const lease = await first.acquire({ cwd: world.repo, id: 'w1', kind: 'run', label: 'Fix' });
      expect(lease.entry).toMatchObject({
        id: 'w1',
        repoRoot: world.repo,
        kind: 'run',
        label: 'Fix',
        slot: 0,
        createdAt: 1001,
        holderPid: ME,
      });
      expect(lease.env['OVERLORD_SLOT']).toBe('0');
      expect(await lease.ready).toStrictEqual([]);
      expect(await readFile(path.join(lease.entry.path, 'slot.txt'), 'utf8')).toBe('0\n');
      expect(await first.entries()).toStrictEqual([lease.entry]);
      const fresh = registry();
      expect(fresh.projectFor(lease.entry.path)).toBe(lease.entry.path);
      await fresh.load();
      expect(fresh.projectFor(lease.entry.path)).toBe(world.repo);
      const second = await first.acquire({
        cwd: world.repo,
        id: 'w2',
        kind: 'session',
        label: 'Chat',
      });
      expect(second.entry.slot).toBe(1);
      expect(JSON.parse(await readFile(path.join(dir, 'repos.json'), 'utf8'))).toStrictEqual({
        [repoFolder(world.repo)]: world.repo,
      });
    });

    it('reuses the slot of a worktree whose holder is gone', async () => {
      const other = registry(OTHER_WINDOW);
      await other.acquire({ cwd: world.repo, id: 'w1', kind: 'run', label: 'A' });
      const mine = registry();
      const next = await mine.acquire({ cwd: world.repo, id: 'w2', kind: 'run', label: 'B' });
      expect(next.entry.slot).toBe(0);
    });

    it('removes a released worktree once everything in it landed', async () => {
      const reg = registry();
      const { entry } = await reg.acquire({ cwd: world.repo, id: 'w1', kind: 'run', label: 'A' });
      await commitFile(entry.path, 'mine.txt', 'mine\n');
      await git(entry.path, 'push', '-q', 'origin', 'HEAD:main');
      expect(await reg.release('w1')).toBe('landed');
      expect(existsSync(entry.path)).toBe(false);
      expect(await reg.entries()).toStrictEqual([]);
      expect(await reg.release('w1')).toBeNull();
    });

    it('keeps released worktrees that still hold work, and any a live session uses', async () => {
      const reg = registry();
      const dirty = await reg.acquire({ cwd: world.repo, id: 'd', kind: 'run', label: 'D' });
      const ahead = await reg.acquire({ cwd: world.repo, id: 'a', kind: 'run', label: 'A' });
      const busy = await reg.acquire({ cwd: world.repo, id: 'b', kind: 'run', label: 'B' });
      await writeFile(path.join(dirty.entry.path, 'a.txt'), 'edited\n');
      await commitFile(ahead.entry.path, 'a.txt', 'committed\n');
      live = [path.join(busy.entry.path, 'src')];
      expect(await reg.release('d')).toBe('dirty');
      expect(await reg.release('a')).toBe('unlanded');
      expect(await reg.release('b')).toBe('active');
      const summaries = await reg.summaries();
      expect(summaries.map((item) => [item.id, item.state, item.ahead, item.dirty])).toStrictEqual([
        ['d', 'dirty', 0, 1],
        ['a', 'unlanded', 1, 0],
        ['b', 'active', 0, 0],
      ]);
      expect(summaries[0]?.overlaps).toStrictEqual([{ id: 'a', label: 'A', files: ['a.txt'] }]);
      expect(summaries[1]).toMatchObject({
        kind: 'run',
        label: 'A',
        repoRoot: world.repo,
        branch: 'overlord/a',
        target: 'main',
        files: ['a.txt'],
      });
    });

    it('tidies on reconcile: forgets missing folders and removes idle landed worktrees', async () => {
      const reg = registry();
      const gone = await reg.acquire({ cwd: world.repo, id: 'g', kind: 'run', label: 'G' });
      const idle = await reg.acquire({ cwd: world.repo, id: 'i', kind: 'run', label: 'I' });
      const held = await reg.acquire({ cwd: world.repo, id: 'h', kind: 'run', label: 'H' });
      await rm(gone.entry.path, { recursive: true, force: true });
      alive.delete(ME);
      alive.add(OTHER_WINDOW);
      await writeFile(
        path.join(dir, 'h.json'),
        JSON.stringify({ ...held.entry, holderPid: OTHER_WINDOW }),
      );
      const before = await reg.summaries();
      expect(before.find((item) => item.id === 'g')?.state).toBe('missing');
      await reg.reconcile();
      const kept = await reg.entries();
      expect(kept.map((entry) => entry.id)).toStrictEqual(['h']);
      expect(existsSync(idle.entry.path)).toBe(false);
      expect(await git(world.repo, 'branch', '--list', 'overlord/g')).toContain('overlord/g');
    });

    it('lands a finished worktree on the default branch and removes it', async () => {
      const reg = registry();
      const { entry } = await reg.acquire({ cwd: world.repo, id: 'w1', kind: 'run', label: 'A' });
      await commitFile(entry.path, 'mine.txt', 'mine\n');
      await expect(reg.land('w1')).rejects.toThrow(`A session is still working in ${entry.path}.`);
      await reg.release('w1');
      await reg.land('w1');
      expect(await git(world.origin, 'ls-tree', '--name-only', 'main')).toContain('mine.txt');
      expect(existsSync(entry.path)).toBe(false);
      expect(await reg.entries()).toStrictEqual([]);
      await expect(reg.land('w1')).rejects.toThrow('Overlord has no worktree w1.');
    });

    it('discards a finished worktree with everything in it', async () => {
      const reg = registry();
      const { entry } = await reg.acquire({ cwd: world.repo, id: 'w1', kind: 'run', label: 'A' });
      await writeFile(path.join(entry.path, 'a.txt'), 'edited\n');
      await reg.release('w1');
      await reg.discard('w1');
      expect(existsSync(entry.path)).toBe(false);
      expect(await reg.entries()).toStrictEqual([]);
    });

    it('holds a kept worktree again for a new session', async () => {
      const reg = registry();
      const { entry } = await reg.acquire({ cwd: world.repo, id: 'w1', kind: 'run', label: 'A' });
      await writeFile(path.join(entry.path, 'a.txt'), 'edited\n');
      await reg.release('w1');
      await reg.acquire({ cwd: world.repo, id: 'w2', kind: 'run', label: 'B' });
      const lease = await reg.hold('w1');
      expect(lease.entry).toMatchObject({ id: 'w1', holderPid: ME, slot: 1 });
      expect(await lease.ready).toStrictEqual([]);
      const held = await reg.summaries();
      expect(held.find((item) => item.id === 'w1')?.state).toBe('active');
      await expect(reg.hold('nope')).rejects.toThrow('Overlord has no worktree nope.');
    });

    it('skips unreadable or malformed records and survives a missing folder', async () => {
      const reg = registry();
      expect(await reg.entries()).toStrictEqual([]);
      await reg.load();
      await mkdir(path.join(dir, 'folder.json'), { recursive: true });
      await writeFile(path.join(dir, 'broken.json'), '{nope');
      await writeFile(path.join(dir, 'wrong.json'), '{"id":"x"}');
      await writeFile(path.join(dir, 'notes.txt'), 'ignored');
      await writeFile(path.join(dir, 'repos.json'), '[1,2]');
      expect(await reg.entries()).toStrictEqual([]);
      await reg.load();
      expect(reg.projectFor('/anywhere')).toBe('/anywhere');
    });

    it('finds the main checkout of a folder, null outside a repository, and passes other failures on', async () => {
      const reg = registry();
      await mkdir(path.join(world.repo, 'sub'), { recursive: true });
      expect(await reg.repoRoot(path.join(world.repo, 'sub'))).toBe(world.repo);
      expect(await reg.repoRoot(dir)).toBeNull();
      const broken = new WorktreeRegistry({
        git: new WorktreeGit(async () => {
          await Promise.resolve();
          throw new Error('spawn failed');
        }, world.root),
        exec: testExec,
        dir,
        root: world.root,
        pid: ME,
        isAlive: (): boolean => false,
        clock: (): number => now,
        liveCwds: async (): Promise<readonly string[]> => {
          await Promise.resolve();
          return [];
        },
      });
      await expect(broken.repoRoot(world.repo)).rejects.toThrow('spawn failed');
    });
  });
});
