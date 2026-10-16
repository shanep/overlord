// Temp HOME folders and real throwaway git repos for the sync tests. Git runs
// with its own global config so the user's settings and hooks never apply.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { onTestFinished } from 'vitest';

import { resolveClaudePaths, type ClaudePaths } from '../../paths.js';
import { createNodeExec, type Exec, type ExecOptions, type ExecResult } from '../exec.js';

/** A fresh temp folder, resolved (macOS puts tmp behind a /var symlink), removed when the test ends. */
export async function scratchDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overlord-sync-')));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Claude paths rooted at a fake home, with the managed folder inside it too. */
export function fakePaths(home: string): ClaudePaths {
  const paths = resolveClaudePaths({ home, platform: 'linux', env: {} });
  return { ...paths, managedDir: path.join(home, 'managed') };
}

export async function writeTree(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/** A real Exec whose git ignores the user's config. Its config folder is removed when the process exits. */
export function isolatedExec(): Exec {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'overlord-git-')));
  process.once('exit', () => {
    rmSync(dir, { recursive: true, force: true });
  });
  const config = path.join(dir, 'gitconfig');
  writeFileSync(
    config,
    '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n',
  );
  const real = createNodeExec();
  const env = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  return async (command, args, options) =>
    real(command, args, { ...options, env: { ...env, ...options.env } });
}

/** Run git and fail the test on a non-zero exit. */
export async function git(exec: Exec, cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec('git', ['-C', cwd, ...args], {});
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout;
}

/** A work tree with one commit holding `files`. */
export async function repoWith(
  exec: Exec,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const dir = await scratchDir();
  await writeTree(dir, files);
  await git(exec, dir, ['init']);
  await git(exec, dir, ['add', '-A']);
  await git(exec, dir, ['commit', '-m', 'first']);
  return dir;
}

/** A bare repo seeded with `files`, usable as a clone URL. */
export async function bareRemoteWith(
  exec: Exec,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const work = await repoWith(exec, files);
  const bare = path.join(await scratchDir(), 'remote.git');
  await git(exec, work, ['clone', '--bare', work, bare]);
  return bare;
}

export interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ExecOptions;
}

/** An Exec that records calls and answers from `respond`. */
export function fakeExec(respond: (call: Call) => ExecResult): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    await Promise.resolve();
    return respond(call);
  };
  return { exec, calls };
}
