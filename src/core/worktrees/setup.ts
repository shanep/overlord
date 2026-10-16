// Gets a fresh worktree ready to build. Git only checks out tracked files, so
// a new worktree has no .env, no node_modules and nothing else the repo
// ignores. Three steps fill that in:
//
// 1. Ignored files matching .worktreeinclude (gitignore syntax, the same file
//    Claude Code reads) are copied from the main checkout.
// 2. node_modules is cloned from the main checkout when the lockfiles match.
//    Clones are copy-on-write where the file system supports it (APFS, btrfs,
//    XFS), so this takes seconds instead of a full install. On macOS the whole
//    tree clones in one call, which takes about a second instead of ten.
// 3. .overlord/setup.sh runs in the worktree, for anything else a repo needs.
//
// A step that fails becomes a warning. The worktree still works, and the
// agent can finish the setup itself.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage } from '../harness/events.js';
import type { Exec } from '../sync/exec.js';

export const INCLUDE_FILE = '.worktreeinclude';
export const SETUP_SCRIPT = path.join('.overlord', 'setup.sh');
const NODE_MODULES = 'node_modules';
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const SETUP_TIMEOUT_MS = 15 * 60_000;
const CLONE_TIMEOUT_MS = 5 * 60_000;

// clonefileat(2) clones a whole directory tree in one call on APFS, where
// cloning it file by file takes seconds for a big node_modules. Node has no
// binding for it, so the system perl makes the call: 462 is SYS_clonefileat
// in <sys/syscall.h> and -2 is AT_FDCWD in <sys/fcntl.h>.
const PERL = '/usr/bin/perl';
const CLONE_TREE = String.raw`syscall(462, -2, $ARGV[0], -2, $ARGV[1], 0) == 0 or die "clonefileat: $!\n"`;

export interface SetupTarget {
  readonly repoRoot: string;
  readonly path: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

/** Ignored files the main checkout has that match .worktreeinclude. */
async function includedFiles(exec: Exec, repoRoot: string): Promise<readonly string[]> {
  if (!(await exists(path.join(repoRoot, INCLUDE_FILE)))) {
    return [];
  }
  const result = await exec(
    'git',
    ['ls-files', '--others', '--ignored', `--exclude-from=${INCLUDE_FILE}`],
    { cwd: repoRoot },
  );
  if (result.code !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split('\n')
    .filter((file) => file !== '' && !file.startsWith(`${NODE_MODULES}/`));
}

async function copyIncluded(exec: Exec, target: SetupTarget): Promise<void> {
  for (const file of await includedFiles(exec, target.repoRoot)) {
    const destination = path.join(target.path, file);
    // The branch may track a file the main checkout still ignores. Keep the branch's copy.
    if (await exists(destination)) {
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(target.repoRoot, file), destination, constants.COPYFILE_FICLONE);
  }
}

/** True when the worktree's lockfiles match the main checkout's, so its node_modules fits. */
async function sameLockfiles(target: SetupTarget): Promise<boolean> {
  let compared = 0;
  for (const name of LOCKFILES) {
    const main = await readOrNull(path.join(target.repoRoot, name));
    if (main !== null) {
      const copy = await readOrNull(path.join(target.path, name));
      if (copy?.equals(main) !== true) {
        return false;
      }
      compared += 1;
    }
  }
  return compared > 0;
}

/** True when macOS cloned the tree in one call. Anything else leaves the copy to Node. */
async function cloneWhole(exec: Exec, source: string, destination: string): Promise<boolean> {
  try {
    const result = await exec(PERL, ['-e', CLONE_TREE, source, destination], {
      timeoutMs: CLONE_TIMEOUT_MS,
    });
    if (result.code === 0) {
      return true;
    }
  } catch {
    // No perl, or it would not start. Copying file by file still works.
  }
  await rm(destination, { recursive: true, force: true });
  return false;
}

async function cloneTree(
  exec: Exec,
  source: string,
  destination: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === 'darwin' && (await cloneWhole(exec, source, destination))) {
    return;
  }
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

async function cloneNodeModules(
  exec: Exec,
  target: SetupTarget,
  platform: NodeJS.Platform,
): Promise<void> {
  const source = path.join(target.repoRoot, NODE_MODULES);
  const destination = path.join(target.path, NODE_MODULES);
  if (!(await exists(source)) || (await exists(destination)) || !(await sameLockfiles(target))) {
    return;
  }
  // The clone is built beside the worktree and moved in whole, so a session
  // already running there never sees half of it, and keeps a node_modules it
  // installed itself in the meantime.
  const staging = `${target.path}.${NODE_MODULES}-${randomUUID()}`;
  try {
    await cloneTree(exec, source, staging, platform);
    try {
      await rename(staging, destination);
    } catch (error: unknown) {
      if (!(await exists(destination))) {
        throw error;
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function runSetupScript(
  exec: Exec,
  target: SetupTarget,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  if (!(await exists(path.join(target.path, SETUP_SCRIPT)))) {
    return;
  }
  const result = await exec('sh', [SETUP_SCRIPT], {
    cwd: target.path,
    env,
    timeoutMs: SETUP_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(`${SETUP_SCRIPT} exited ${String(result.code)}: ${result.stderr.trim()}`);
  }
}

/** Runs every setup step and returns a warning for each one that failed. */
export async function setUpWorktree(
  exec: Exec,
  target: SetupTarget,
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): Promise<readonly string[]> {
  const steps: readonly [string, () => Promise<void>][] = [
    [`Copying ${INCLUDE_FILE} files`, async (): Promise<void> => copyIncluded(exec, target)],
    ['Cloning node_modules', async (): Promise<void> => cloneNodeModules(exec, target, platform)],
    [`Running ${SETUP_SCRIPT}`, async (): Promise<void> => runSetupScript(exec, target, env)],
  ];
  const warnings: string[] = [];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (error: unknown) {
      warnings.push(`${label} failed: ${errorMessage(error)}`);
    }
  }
  return warnings;
}
