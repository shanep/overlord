import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Exec } from './exec.js';
import {
  aheadBehind,
  clone,
  commitAll,
  fetch,
  GitError,
  isDirty,
  isIgnored,
  parsePorcelain,
  pull,
  push,
  remoteUrl,
  repoRootOf,
  statusPorcelain,
} from './git.js';
import {
  bareRemoteWith,
  fakeExec,
  git,
  isolatedExec,
  repoWith,
  scratchDir,
} from './test-helpers/fixtures.js';

const exec: Exec = isolatedExec();

describe('parsePorcelain', () => {
  it('reads codes, paths and renames', () => {
    const output = ' M a.txt\0?? dir/b c.md\0R  new.md\0old.md\0A  x\0';
    expect(parsePorcelain(output)).toStrictEqual([
      { code: ' M', path: 'a.txt', origPath: null },
      { code: '??', path: 'dir/b c.md', origPath: null },
      { code: 'R ', path: 'new.md', origPath: 'old.md' },
      { code: 'A ', path: 'x', origPath: null },
    ]);
  });

  it('reads copies and handles empty output', () => {
    expect(parsePorcelain('C  b\0a\0')).toStrictEqual([{ code: 'C ', path: 'b', origPath: 'a' }]);
    expect(parsePorcelain('R  b\0')).toStrictEqual([{ code: 'R ', path: 'b', origPath: null }]);
    expect(parsePorcelain('R  b')).toStrictEqual([{ code: 'R ', path: 'b', origPath: null }]);
    expect(parsePorcelain('')).toStrictEqual([]);
  });
});

describe('repoRootOf and remoteUrl', () => {
  it('finds the root from a file, a folder and a missing file', async () => {
    const root = await repoWith(exec, { 'a/b.txt': 'b' });
    expect(await repoRootOf(exec, path.join(root, 'a', 'b.txt'))).toBe(root);
    expect(await repoRootOf(exec, path.join(root, 'a'))).toBe(root);
    expect(await repoRootOf(exec, path.join(root, 'a', 'missing.txt'))).toBe(root);
  });

  it('returns null outside a repo', async () => {
    const dir = await scratchDir();
    expect(await repoRootOf(exec, dir)).toBeNull();
  });

  it('reads a remote by name and returns null when it is missing', async () => {
    const root = await repoWith(exec, { a: 'a' });
    expect(await remoteUrl(exec, root)).toBeNull();
    await git(exec, root, ['remote', 'add', 'origin', 'git@github.com:a/b.git']);
    await git(exec, root, ['remote', 'add', 'other', 'https://example.com/c/d']);
    expect(await remoteUrl(exec, root)).toBe('git@github.com:a/b.git');
    expect(await remoteUrl(exec, root, 'other')).toBe('https://example.com/c/d');
  });

  it('treats empty output as no answer', async () => {
    const fake = fakeExec(() => ({ code: 0, stdout: '  \n', stderr: '' }));
    expect(await repoRootOf(fake.exec, '/x')).toBeNull();
    expect(await remoteUrl(fake.exec, '/x')).toBeNull();
  });
});

describe('status helpers', () => {
  it('reports changes for the whole repo or one path', async () => {
    const root = await repoWith(exec, { 'a.txt': 'a', 'b.txt': 'b' });
    expect(await isDirty(exec, root)).toBe(false);
    await writeFile(path.join(root, 'a.txt'), 'changed');
    await writeFile(path.join(root, 'new.txt'), 'n');
    expect(await statusPorcelain(exec, root)).toStrictEqual([
      { code: ' M', path: 'a.txt', origPath: null },
      { code: '??', path: 'new.txt', origPath: null },
    ]);
    expect(await isDirty(exec, root)).toBe(true);
    expect(await isDirty(exec, root, path.join(root, 'a.txt'))).toBe(true);
    expect(await isDirty(exec, root, path.join(root, 'b.txt'))).toBe(false);
  });

  it('throws a GitError outside a repo', async () => {
    const dir = await scratchDir();
    await expect(statusPorcelain(exec, dir)).rejects.toBeInstanceOf(GitError);
  });

  it('knows ignored files', async () => {
    const root = await repoWith(exec, { '.gitignore': '*.local\n', 'a.txt': 'a' });
    expect(await isIgnored(exec, root, path.join(root, 'x.local'))).toBe(true);
    expect(await isIgnored(exec, root, path.join(root, 'a.txt'))).toBe(false);
  });
});

describe('remote round trips', () => {
  it('clones, commits, pushes, fetches and pulls', async () => {
    const remote = await bareRemoteWith(exec, { 'a.txt': 'a' });
    const one = path.join(await scratchDir(), 'one');
    const two = path.join(await scratchDir(), 'two');
    await clone(exec, remote, one);
    await clone(exec, remote, two);
    expect(await aheadBehind(exec, one)).toStrictEqual({ ahead: 0, behind: 0, hasUpstream: true });

    expect(await commitAll(exec, one, 'nothing')).toBe(false);
    await writeFile(path.join(one, 'b.txt'), 'b');
    expect(await commitAll(exec, one, 'add b')).toBe(true);
    expect(await git(exec, one, ['log', '-1', '--format=%s'])).toBe('add b\n');
    expect(await isDirty(exec, one)).toBe(false);
    expect(await aheadBehind(exec, one)).toStrictEqual({ ahead: 1, behind: 0, hasUpstream: true });

    await push(exec, one);
    expect(await aheadBehind(exec, one)).toStrictEqual({ ahead: 0, behind: 0, hasUpstream: true });

    await fetch(exec, two);
    expect(await aheadBehind(exec, two)).toStrictEqual({ ahead: 0, behind: 1, hasUpstream: true });
    await pull(exec, two);
    expect(await aheadBehind(exec, two)).toStrictEqual({ ahead: 0, behind: 0, hasUpstream: true });
  });

  it('pushes a new branch and sets its upstream', async () => {
    const remote = await bareRemoteWith(exec, { 'a.txt': 'a' });
    const root = await repoWith(exec, { 'b.txt': 'b' });
    await git(exec, root, ['remote', 'add', 'origin', remote]);
    expect(await aheadBehind(exec, root)).toStrictEqual({
      ahead: 0,
      behind: 0,
      hasUpstream: false,
    });
    await git(exec, root, ['checkout', '-b', 'side']);
    await push(exec, root);
    expect(await git(exec, root, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe(
      'origin/side\n',
    );
  });

  it('refuses a pull that is not a fast forward', async () => {
    const remote = await bareRemoteWith(exec, { 'a.txt': 'a' });
    const one = path.join(await scratchDir(), 'one');
    const two = path.join(await scratchDir(), 'two');
    await clone(exec, remote, one);
    await clone(exec, remote, two);
    await writeFile(path.join(one, 'a.txt'), 'one');
    await commitAll(exec, one, 'one');
    await push(exec, one);
    await writeFile(path.join(two, 'a.txt'), 'two');
    await commitAll(exec, two, 'two');
    await expect(pull(exec, two)).rejects.toBeInstanceOf(GitError);
  });

  it('describes a failed command', async () => {
    const destination = path.join(await scratchDir(), 'x');
    const error: unknown = await clone(exec, path.join(destination, 'missing'), destination).catch(
      (error_: unknown) => error_,
    );
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({
      name: 'GitError',
      args: ['clone', '--', path.join(destination, 'missing'), destination],
      result: { code: 128 },
    });
    expect(String(error)).toMatch(/^GitError: git clone -- .* failed \(128\): \S/u);
  });
});

describe('how git is run', () => {
  it('never prompts, never takes optional locks, and passes paths after --', async () => {
    const fake = fakeExec(() => ({ code: 0, stdout: '', stderr: '' }));
    await isIgnored(fake.exec, '/r', '-rf');
    await clone(fake.exec, '--upload-pack=x', '/d');
    expect(fake.calls[0]?.args).toStrictEqual(['-C', '/r', 'check-ignore', '-q', '--', '-rf']);
    expect(fake.calls[1]?.args).toStrictEqual(['clone', '--', '--upload-pack=x', '/d']);
    expect(fake.calls[0]?.command).toBe('git');
    expect(fake.calls[0]?.options.env).toStrictEqual({
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    });
    expect(fake.calls[0]?.options.timeoutMs).toBe(30_000);
    expect(fake.calls[1]?.options.timeoutMs).toBe(300_000);
  });

  it('uses the expected subcommands', async () => {
    const fake = fakeExec((call) => ({
      code: call.args.includes('--quiet') && call.args.includes('diff') ? 1 : 0,
      stdout: '',
      stderr: '',
    }));
    await commitAll(fake.exec, '/r', 'msg');
    await push(fake.exec, '/r', 'up');
    await pull(fake.exec, '/r');
    await fetch(fake.exec, '/r');
    await statusPorcelain(fake.exec, '/r', '/r/a');
    expect(fake.calls.map((call) => call.args)).toStrictEqual([
      ['-C', '/r', 'add', '-A'],
      ['-C', '/r', 'diff', '--cached', '--quiet'],
      ['-C', '/r', 'commit', '-q', '-m', 'msg'],
      ['-C', '/r', 'push', '-q', '-u', 'up', 'HEAD'],
      ['-C', '/r', 'pull', '-q', '--ff-only'],
      ['-C', '/r', 'fetch', '--quiet'],
      ['-C', '/r', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '/r/a'],
    ]);
    expect(fake.calls.map((call) => call.options.timeoutMs)).toStrictEqual([
      30_000, 30_000, 30_000, 300_000, 300_000, 300_000, 30_000,
    ]);
  });

  it('reads ahead and behind counts and ignores junk', async () => {
    const counts = fakeExec(() => ({ code: 0, stdout: '3\t7\n', stderr: '' }));
    expect(await aheadBehind(counts.exec, '/r')).toStrictEqual({
      ahead: 3,
      behind: 7,
      hasUpstream: true,
    });
    expect(counts.calls[0]?.args).toStrictEqual([
      '-C',
      '/r',
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...@{upstream}',
    ]);
    const junk = fakeExec(() => ({ code: 0, stdout: 'x 1', stderr: '' }));
    expect(await aheadBehind(junk.exec, '/r')).toStrictEqual({
      ahead: 0,
      behind: 0,
      hasUpstream: false,
    });
    const failed = fakeExec(() => ({ code: 1, stdout: '1 2', stderr: '' }));
    expect(await aheadBehind(failed.exec, '/r')).toStrictEqual({
      ahead: 0,
      behind: 0,
      hasUpstream: false,
    });
  });
});
