// Throwaway git setups for worktree tests: a bare origin, a clone to work in,
// and a second clone that plays another session landing work first. Git runs
// with no global or system config, so the user's signing, hooks and default
// branch never leak in.

import { chmod, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createNodeExec, type Exec, type ExecResult } from '../../sync/exec.js';

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'Overlord Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Overlord Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const node = createNodeExec();

/** The real exec with the isolated git environment. */
export const testExec: Exec = async (command, args, options) =>
  node(command, args, { ...options, env: { ...GIT_ENV, ...options.env } });

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await testExec('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function commitFile(cwd: string, file: string, text: string): Promise<string> {
  await writeFile(path.join(cwd, file), text);
  await git(cwd, 'add', file);
  await git(cwd, 'commit', '-q', '-m', `Change ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

export interface GitWorld {
  readonly dir: string;
  readonly origin: string;
  /** The main checkout worktrees are made from. */
  readonly repo: string;
  /** Another clone, for landing work behind the repo's back. */
  readonly other: string;
  /** Where worktrees go. */
  readonly root: string;
}

export async function makeWorld(): Promise<GitWorld> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overlord-git-')));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  await git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  await git(dir, 'init', '-q', '-b', 'main', seed);
  await commitFile(seed, 'a.txt', 'one\n');
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(seed, 'push', '-q', 'origin', 'main');
  const repo = path.join(dir, 'repo');
  const other = path.join(dir, 'other');
  await git(dir, 'clone', '-q', origin, repo);
  await git(dir, 'clone', '-q', origin, other);
  return { dir, origin, repo, other, root: path.join(dir, 'worktrees') };
}

/** A pre-push hook in the shared hooks folder, so it runs from every worktree. */
export async function failPrePush(repo: string): Promise<void> {
  const hook = path.join(repo, '.git', 'hooks', 'pre-push');
  await writeFile(hook, '#!/bin/sh\necho checks failed >&2\nexit 1\n');
  await chmod(hook, 0o755);
}

export type Responder = (args: readonly string[]) => ExecResult | null;

/** A fake exec that answers git by the first responder that knows the arguments. */
export function scriptedExec(responders: readonly Responder[], calls: string[][] = []): Exec {
  return async (_command, args) => {
    calls.push([...args]);
    await Promise.resolve();
    for (const respond of responders) {
      const result = respond(args);
      if (result !== null) {
        return result;
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

export function ok(stdout = ''): ExecResult {
  return { code: 0, stdout, stderr: '' };
}

export function fail(stderr = ''): ExecResult {
  return { code: 1, stdout: '', stderr };
}
