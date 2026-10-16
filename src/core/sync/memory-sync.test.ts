import { readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Exec } from './exec.js';
import { pathExists } from './files.js';
import {
  decideFile,
  type MemorySyncOptions,
  type ProjectSync,
  readMemoryState,
  syncMemory,
} from './memory-sync.js';
import { git, isolatedExec, repoWith, scratchDir, writeTree } from './test-helpers/fixtures.js';

const exec: Exec = isolatedExec();

const slug = 'github.com/me/proj';
const token = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('decideFile', () => {
  it('makes the three way choice', () => {
    expect(decideFile('a', 'a', null)).toBe('none');
    expect(decideFile(null, null, 'a')).toBe('none');
    expect(decideFile('b', 'a', 'a')).toBe('to-repo');
    expect(decideFile('a', null, null)).toBe('to-repo');
    expect(decideFile(null, 'a', 'a')).toBe('remove-repo');
    expect(decideFile('a', 'b', 'a')).toBe('to-local');
    expect(decideFile(null, 'a', null)).toBe('to-local');
    expect(decideFile('a', null, 'a')).toBe('remove-local');
    expect(decideFile('b', 'c', 'a')).toBe('conflict');
    expect(decideFile('b', 'c', null)).toBe('conflict');
    expect(decideFile(null, 'c', 'a')).toBe('conflict');
  });
});

interface Setup {
  readonly options: MemorySyncOptions;
  readonly local: string;
  readonly remote: string;
  readonly backup: string;
}

async function setup(
  local: Readonly<Record<string, string>>,
  repo: Readonly<Record<string, string>>,
): Promise<Setup> {
  const cwd = await repoWith(exec, { 'README.md': 'p' });
  await git(exec, cwd, ['remote', 'add', 'origin', 'git@github.com:Me/proj.git']);
  const projects = await scratchDir();
  const projectDir = path.join(projects, '-x');
  const repoRoot = await scratchDir();
  await writeTree(path.join(projectDir, 'memory'), local);
  await writeTree(path.join(repoRoot, 'memory', 'github.com', 'me', 'proj'), repo);
  const state = await scratchDir();
  const options: MemorySyncOptions = {
    projects: [{ projectDir, cwd }],
    repoRoot,
    exec,
    statePath: path.join(state, 'nested', 'memory-state.json'),
    backupDir: path.join(state, 'backup'),
  };
  return {
    options,
    local: path.join(projectDir, 'memory'),
    remote: path.join(repoRoot, 'memory', 'github.com', 'me', 'proj'),
    backup: path.join(state, 'backup', 'github.com', 'me', 'proj'),
  };
}

async function only(options: MemorySyncOptions): Promise<ProjectSync> {
  const result = await syncMemory(options);
  expect(result.skipped).toStrictEqual([]);
  expect(result.synced).toHaveLength(1);
  const [first] = result.synced;
  if (first === undefined) {
    throw new Error('no project synced');
  }
  return first;
}

function quiet(projectDir: string): ProjectSync {
  return {
    projectDir,
    slug,
    toRepo: [],
    toLocal: [],
    removedFromRepo: [],
    removedLocal: [],
    conflicts: [],
    blocked: [],
  };
}

async function setTime(file: string, seconds: number): Promise<void> {
  const when = new Date(seconds * 1000);
  await utimes(file, when, when);
}

describe('syncMemory', () => {
  it('copies both ways on the first sync, then does nothing', async () => {
    const { options, local, remote } = await setup(
      { 'MEMORY.md': 'm', 'notes/a.md': 'a' },
      { 'b.md': 'b' },
    );
    const projectDir = options.projects[0]?.projectDir ?? '';
    expect(await only(options)).toStrictEqual({
      ...quiet(projectDir),
      toRepo: ['MEMORY.md', 'notes/a.md'],
      toLocal: ['b.md'],
    });
    expect(await readFile(path.join(remote, 'notes', 'a.md'), 'utf8')).toBe('a');
    expect(await readFile(path.join(local, 'b.md'), 'utf8')).toBe('b');
    const state = await readMemoryState(options.statePath);
    expect(Object.keys(state.projects[projectDir] ?? {})).toStrictEqual([
      'MEMORY.md',
      'b.md',
      'notes/a.md',
    ]);
    expect(await only(options)).toStrictEqual(quiet(projectDir));
  });

  it('carries edits and deletions from either side, backing up what it replaces', async () => {
    const { options, local, remote, backup } = await setup(
      { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c', 'd.md': 'd' },
      {},
    );
    const projectDir = options.projects[0]?.projectDir ?? '';
    await only(options);
    await writeFile(path.join(local, 'a.md'), 'a2');
    await writeFile(path.join(remote, 'b.md'), 'b2');
    await rm(path.join(local, 'c.md'));
    await rm(path.join(remote, 'd.md'));
    expect(await only(options)).toStrictEqual({
      ...quiet(projectDir),
      toRepo: ['a.md'],
      toLocal: ['b.md'],
      removedFromRepo: ['c.md'],
      removedLocal: ['d.md'],
    });
    expect(await readFile(path.join(remote, 'a.md'), 'utf8')).toBe('a2');
    expect(await readFile(path.join(local, 'b.md'), 'utf8')).toBe('b2');
    expect(await pathExists(path.join(remote, 'c.md'))).toBe(false);
    expect(await pathExists(path.join(local, 'd.md'))).toBe(false);
    expect(await readFile(path.join(backup, 'repo', 'a.md'), 'utf8')).toBe('a');
    expect(await readFile(path.join(backup, 'local', 'b.md'), 'utf8')).toBe('b');
    expect(await readFile(path.join(backup, 'repo', 'c.md'), 'utf8')).toBe('c');
    expect(await readFile(path.join(backup, 'local', 'd.md'), 'utf8')).toBe('d');
    const state = await readMemoryState(options.statePath);
    expect(Object.keys(state.projects[projectDir] ?? {})).toStrictEqual(['a.md', 'b.md']);
    expect(await only(options)).toStrictEqual(quiet(projectDir));
  });

  it('lets the newer side win a conflict and keeps the loser', async () => {
    const { options, local, remote, backup } = await setup({ 'a.md': 'a', 'b.md': 'b' }, {});
    const projectDir = options.projects[0]?.projectDir ?? '';
    await only(options);
    await writeFile(path.join(local, 'a.md'), 'local a');
    await writeFile(path.join(remote, 'a.md'), 'repo a');
    await setTime(path.join(local, 'a.md'), 2000);
    await setTime(path.join(remote, 'a.md'), 1000);
    await writeFile(path.join(local, 'b.md'), 'local b');
    await writeFile(path.join(remote, 'b.md'), 'repo b');
    await setTime(path.join(local, 'b.md'), 1000);
    await setTime(path.join(remote, 'b.md'), 2000);
    expect(await only(options)).toStrictEqual({
      ...quiet(projectDir),
      toRepo: ['a.md'],
      toLocal: ['b.md'],
      conflicts: [
        { file: 'a.md', winner: 'local' },
        { file: 'b.md', winner: 'repo' },
      ],
    });
    expect(await readFile(path.join(remote, 'a.md'), 'utf8')).toBe('local a');
    expect(await readFile(path.join(local, 'b.md'), 'utf8')).toBe('repo b');
    expect(await readFile(path.join(backup, 'repo', 'a.md'), 'utf8')).toBe('repo a');
    expect(await readFile(path.join(backup, 'local', 'b.md'), 'utf8')).toBe('local b');
  });

  it('keeps a changed file over a deletion on the other side', async () => {
    const { options, local, remote } = await setup({ 'a.md': 'a', 'b.md': 'b' }, {});
    const projectDir = options.projects[0]?.projectDir ?? '';
    await only(options);
    await rm(path.join(local, 'a.md'));
    await writeFile(path.join(remote, 'a.md'), 'repo edit');
    await writeFile(path.join(local, 'b.md'), 'local edit');
    await rm(path.join(remote, 'b.md'));
    expect(await only(options)).toStrictEqual({
      ...quiet(projectDir),
      toRepo: ['b.md'],
      toLocal: ['a.md'],
      conflicts: [
        { file: 'a.md', winner: 'repo' },
        { file: 'b.md', winner: 'local' },
      ],
    });
    expect(await readFile(path.join(local, 'a.md'), 'utf8')).toBe('repo edit');
    expect(await readFile(path.join(remote, 'b.md'), 'utf8')).toBe('local edit');
  });

  it('keeps files that look like they hold a secret out of the repo', async () => {
    const { options, remote } = await setup(
      { 'creds.md': `token ${token}\nkey AKIAABCDEFGHIJKLMNOP\n${token}` },
      {},
    );
    const projectDir = options.projects[0]?.projectDir ?? '';
    expect(await only(options)).toStrictEqual({
      ...quiet(projectDir),
      blocked: [{ file: 'creds.md', rules: ['github-token', 'aws-access-key'] }],
    });
    expect(await pathExists(path.join(remote, 'creds.md'))).toBe(false);
    const state = await readMemoryState(options.statePath);
    expect(state.projects[projectDir]).toStrictEqual({});
  });

  it('shares one repo folder between worktrees of the same project', async () => {
    const { options, local } = await setup({ 'a.md': 'a' }, {});
    await only(options);
    const second = path.join(await scratchDir(), '-worktree');
    const cwd = options.projects[0]?.cwd ?? '';
    const both = await syncMemory({ ...options, projects: [{ projectDir: second, cwd }] });
    expect(both.synced[0]?.toLocal).toStrictEqual(['a.md']);
    expect(both.synced[0]?.removedFromRepo).toStrictEqual([]);
    expect(await readFile(path.join(second, 'memory', 'a.md'), 'utf8')).toBe('a');
    expect(await readFile(path.join(local, 'a.md'), 'utf8')).toBe('a');
  });

  it('skips projects it cannot key by a portable remote', async () => {
    const { options } = await setup({}, {});
    const noRepo = await scratchDir();
    const noRemote = await repoWith(exec, { 'a.md': 'a' });
    const localRemote = await repoWith(exec, { 'a.md': 'a' });
    await git(exec, localRemote, ['remote', 'add', 'origin', '/srv/git/x.git']);
    const result = await syncMemory({
      ...options,
      projects: [
        { projectDir: '/p/1', cwd: noRepo },
        { projectDir: '/p/2', cwd: noRemote },
        { projectDir: '/p/3', cwd: localRemote },
      ],
    });
    expect(result).toStrictEqual({
      synced: [],
      skipped: [
        { projectDir: '/p/1', reason: 'not-a-git-repo' },
        { projectDir: '/p/2', reason: 'no-remote' },
        { projectDir: '/p/3', reason: 'remote-not-portable' },
      ],
    });
  });

  it('starts fresh from a missing or broken state file', async () => {
    const dir = await scratchDir();
    const empty = { version: 1, projects: {} };
    expect(await readMemoryState(path.join(dir, 'missing.json'))).toStrictEqual(empty);
    await writeTree(dir, { 'bad.json': '{"version":2}', 'junk.json': 'nope' });
    expect(await readMemoryState(path.join(dir, 'bad.json'))).toStrictEqual(empty);
    expect(await readMemoryState(path.join(dir, 'junk.json'))).toStrictEqual(empty);
    await writeTree(dir, { 'good.json': '{"version":1,"projects":{"/p":{"a.md":"h"}}}' });
    expect(await readMemoryState(path.join(dir, 'good.json'))).toStrictEqual({
      version: 1,
      projects: { '/p': { 'a.md': 'h' } },
    });
  });
});
