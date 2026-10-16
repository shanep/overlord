// Thin git helpers on top of Exec. Paths are passed after `--` so a file name
// can never be read as an option.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { Exec, ExecResult } from './exec.js';

export class GitError extends Error {
  readonly args: readonly string[];
  readonly result: ExecResult;

  constructor(args: readonly string[], result: ExecResult) {
    super(`git ${args.join(' ')} failed (${String(result.code)}): ${result.stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.result = result;
  }
}

export interface StatusEntry {
  /** Two letter porcelain code, for example " M", "??" or "R ". */
  readonly code: string;
  readonly path: string;
  readonly origPath: string | null;
}

export interface AheadBehind {
  readonly ahead: number;
  readonly behind: number;
  readonly hasUpstream: boolean;
}

const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 300_000;
// Never wait on a terminal prompt for credentials inside the editor, and never
// let a status check rewrite the index of a repo the user is working in.
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

async function run(exec: Exec, args: readonly string[], timeoutMs: number): Promise<ExecResult> {
  return exec('git', args, { timeoutMs, env: GIT_ENV });
}

async function runOk(exec: Exec, args: readonly string[], timeoutMs: number): Promise<string> {
  const result = await run(exec, args, timeoutMs);
  if (result.code !== 0) {
    throw new GitError(args, result);
  }
  return result.stdout;
}

async function directoryFor(target: string): Promise<string> {
  try {
    const info = await stat(target);
    return info.isDirectory() ? target : path.dirname(target);
  } catch {
    return path.dirname(target);
  }
}

/** The top level of the work tree holding `target`, or null when it is not in one. */
export async function repoRootOf(exec: Exec, target: string): Promise<string | null> {
  const dir = await directoryFor(target);
  const result = await run(exec, ['-C', dir, 'rev-parse', '--show-toplevel'], LOCAL_TIMEOUT_MS);
  const root = result.stdout.trim();
  return result.code === 0 && root !== '' ? root : null;
}

export async function remoteUrl(
  exec: Exec,
  root: string,
  remote = 'origin',
): Promise<string | null> {
  const result = await run(exec, ['-C', root, 'remote', 'get-url', remote], LOCAL_TIMEOUT_MS);
  const url = result.stdout.trim();
  return result.code === 0 && url !== '' ? url : null;
}

/** Parse `git status --porcelain=v1 -z` output. */
export function parsePorcelain(output: string): readonly StatusEntry[] {
  const parts = output.split('\0')[Symbol.iterator]();
  const entries: StatusEntry[] = [];
  for (const part of parts) {
    if (part.length < 4) {
      continue;
    }
    const code = part.slice(0, 2);
    // A rename or copy is followed by its old path as the next field.
    const next = code.includes('R') || code.includes('C') ? parts.next().value : undefined;
    const origPath = next === undefined || next === '' ? null : next;
    entries.push({ code, path: part.slice(3), origPath });
  }
  return entries;
}

export async function statusPorcelain(
  exec: Exec,
  root: string,
  target?: string,
): Promise<readonly StatusEntry[]> {
  const args = ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'];
  const scoped = target === undefined ? args : [...args, '--', target];
  return parsePorcelain(await runOk(exec, scoped, LOCAL_TIMEOUT_MS));
}

export async function isDirty(exec: Exec, root: string, target?: string): Promise<boolean> {
  const entries = await statusPorcelain(exec, root, target);
  return entries.length > 0;
}

export async function isIgnored(exec: Exec, root: string, target: string): Promise<boolean> {
  const args = ['-C', root, 'check-ignore', '-q', '--', target];
  const result = await run(exec, args, LOCAL_TIMEOUT_MS);
  return result.code === 0;
}

/** Commits ahead of and behind the upstream. No upstream (or no commits) reads as zero. */
export async function aheadBehind(exec: Exec, root: string): Promise<AheadBehind> {
  const args = ['-C', root, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'];
  const result = await run(exec, args, LOCAL_TIMEOUT_MS);
  const match = /^(\d+)\s+(\d+)/u.exec(result.stdout.trim());
  if (result.code !== 0 || match === null) {
    return { ahead: 0, behind: 0, hasUpstream: false };
  }
  return { ahead: Number(match[1]), behind: Number(match[2]), hasUpstream: true };
}

export async function clone(exec: Exec, url: string, destination: string): Promise<void> {
  await runOk(exec, ['clone', '--', url, destination], NETWORK_TIMEOUT_MS);
}

/** Stage everything and commit. Returns false when there was nothing to commit. */
export async function commitAll(exec: Exec, root: string, message: string): Promise<boolean> {
  await runOk(exec, ['-C', root, 'add', '-A'], LOCAL_TIMEOUT_MS);
  const staged = await run(exec, ['-C', root, 'diff', '--cached', '--quiet'], LOCAL_TIMEOUT_MS);
  if (staged.code === 0) {
    return false;
  }
  await runOk(exec, ['-C', root, 'commit', '-q', '-m', message], LOCAL_TIMEOUT_MS);
  return true;
}

export async function fetch(exec: Exec, root: string): Promise<void> {
  await runOk(exec, ['-C', root, 'fetch', '--quiet'], NETWORK_TIMEOUT_MS);
}

/** Push the current branch and set its upstream. */
export async function push(exec: Exec, root: string, remote = 'origin'): Promise<void> {
  await runOk(exec, ['-C', root, 'push', '-q', '-u', remote, 'HEAD'], NETWORK_TIMEOUT_MS);
}

/** Fast forward only, so a diverged config repo is reported instead of merged blindly. */
export async function pull(exec: Exec, root: string): Promise<void> {
  await runOk(exec, ['-C', root, 'pull', '-q', '--ff-only'], NETWORK_TIMEOUT_MS);
}
