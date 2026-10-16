import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rejected, resolved } from '../../../test/fake-claude/fake-query.js';

import { WorktreeManager, nodeExec, parseWorktreeList, type ExecFunction } from './worktree.js';

// Repository settings that keep the user's global git config (signing, hooks)
// out of these throwaway repos.
const GIT_FLAGS = [
  '-c',
  'user.name=Overlord Test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await nodeExec('git', [...GIT_FLAGS, ...args], { cwd });
  return stdout;
}

const notARepo: ExecFunction = async () => rejected(new Error('fatal: not a git repository'));

describe('parseWorktreeList', () => {
  it('keeps only overlord branches', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD 111',
      'branch refs/heads/main',
      '',
      'worktree /repo/.claude/worktrees/overlord-a',
      'HEAD 222',
      'branch refs/heads/overlord/a',
      '',
      'worktree /repo/detached',
      'HEAD 333',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeList(porcelain)).toStrictEqual([
      { path: '/repo/.claude/worktrees/overlord-a', branch: 'overlord/a', head: '222' },
    ]);
    expect(parseWorktreeList('')).toStrictEqual([]);
  });
});

describe('WorktreeManager with a fake exec', () => {
  it('refuses a cwd outside a git repository', async () => {
    const manager = new WorktreeManager(notARepo);
    await expect(manager.repoRoot('/nowhere')).rejects.toThrow(
      '/nowhere is not inside a git repository',
    );
    await expect(manager.create('/nowhere', 'run1')).rejects.toThrow('not inside a git repository');
  });

  it('rejects run ids that could escape the worktree folder', async () => {
    const calls: string[][] = [];
    const exec: ExecFunction = async (_command, args) => {
      calls.push([...args]);
      return resolved({ stdout: '/repo\n', stderr: '' });
    };
    const manager = new WorktreeManager(exec);
    await expect(manager.create('/repo', '../evil')).rejects.toThrow(
      'Run id "../evil" may only hold letters, digits, _ and -',
    );
    await expect(manager.create('/repo', '')).rejects.toThrow('may only hold');
    expect(calls).toStrictEqual([]);
  });

  it('issues the expected git commands', async () => {
    const calls: { cwd: string; args: string[] }[] = [];
    const exec: ExecFunction = async (command, args, options) => {
      expect(command).toBe('git');
      calls.push({ cwd: options.cwd, args: [...args] });
      const stdout = args[0] === 'rev-parse' && args[1] === 'HEAD' ? 'abc123\n' : '/repo\n';
      return resolved({ stdout, stderr: '' });
    };
    const manager = new WorktreeManager(exec);
    const info = await manager.create('/repo/sub', 'run_1-a');
    const wtPath = path.join('/repo', '.claude', 'worktrees', 'overlord-run_1-a');
    expect(info).toStrictEqual({
      runId: 'run_1-a',
      repoRoot: '/repo',
      path: wtPath,
      branch: 'overlord/run_1-a',
      baseCommit: 'abc123',
    });
    await manager.diff(info);
    await manager.remove(info);
    expect(calls).toStrictEqual([
      { cwd: '/repo/sub', args: ['rev-parse', '--show-toplevel'] },
      { cwd: '/repo', args: ['rev-parse', 'HEAD'] },
      { cwd: '/repo', args: ['worktree', 'add', '-b', 'overlord/run_1-a', wtPath, 'abc123'] },
      { cwd: wtPath, args: ['add', '--all', '--intent-to-add'] },
      { cwd: wtPath, args: ['diff', '--stat', 'abc123'] },
      { cwd: wtPath, args: ['diff', 'abc123'] },
      { cwd: '/repo', args: ['worktree', 'remove', '--force', wtPath] },
      { cwd: '/repo', args: ['branch', '-D', 'overlord/run_1-a'] },
    ]);
  });
});

describe('WorktreeManager with real git', () => {
  let root = '';

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overlord-wt-')));
    await git(root, ['init', '-q']);
    await writeFile(path.join(root, 'a.txt'), 'one\n');
    await git(root, ['add', 'a.txt']);
    await git(root, ['commit', '-q', '-m', 'base']);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('creates, lists, diffs and removes a worktree', async () => {
    const manager = new WorktreeManager();
    expect(await manager.repoRoot(root)).toBe(root);
    const info = await manager.create(root, 'r1');
    expect(info.path).toBe(path.join(root, '.claude', 'worktrees', 'overlord-r1'));
    expect(info.baseCommit).toMatch(/^[\da-f]{40}$/);
    expect(existsSync(path.join(info.path, 'a.txt'))).toBe(true);
    const listed = await manager.list(root);
    expect(listed).toStrictEqual([
      { path: info.path, branch: 'overlord/r1', head: info.baseCommit },
    ]);

    await writeFile(path.join(info.path, 'a.txt'), 'one\ntwo\n');
    await writeFile(path.join(info.path, 'b.txt'), 'new file\n');
    const diff = await manager.diff(info);
    expect(diff.stat).toContain('a.txt');
    expect(diff.stat).toContain('b.txt');
    expect(diff.stat).toContain('2 files changed');
    expect(diff.patch).toContain('+two');
    expect(diff.patch).toContain('+new file');

    await manager.remove(info);
    expect(existsSync(info.path)).toBe(false);
    expect(await manager.list(root)).toStrictEqual([]);
    const branches = await git(root, ['branch', '--list', 'overlord/*']);
    expect(branches.trim()).toBe('');
  });

  it('ignores git location variables from a surrounding hook', async () => {
    vi.stubEnv('GIT_DIR', path.join(root, 'nope'));
    vi.stubEnv('GIT_INDEX_FILE', path.join(root, 'nope-index'));
    const manager = new WorktreeManager();
    expect(await manager.repoRoot(root)).toBe(root);
  });

  it('reports git failures', async () => {
    await expect(nodeExec('git', ['no-such-command'], { cwd: root })).rejects.toThrow();
  });
});
