import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../sync/exec.js';

import { INCLUDE_FILE, SETUP_SCRIPT, setUpWorktree, type SetupTarget } from './setup.js';
import { fail, git, ok, scriptedExec, testExec } from './test-helpers/git-world.js';

let dir: string;
let target: SetupTarget;

async function put(root: string, file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

// Each test runs real git many times, which takes far longer than usual on a busy machine.
describe('worktree setup', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overlord-setup-')));
    target = { repoRoot: path.join(dir, 'repo'), path: path.join(dir, 'wt') };
    await mkdir(target.repoRoot);
    await mkdir(target.path);
    await git(target.repoRoot, 'init', '-q', '-b', 'main');
    await put(target.repoRoot, '.gitignore', '.env\nconfig/local.json\nnode_modules/\nbig.log\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('setUpWorktree', () => {
    it('does nothing for a repo with none of the setup files', async () => {
      expect(await setUpWorktree(testExec, target, {})).toStrictEqual([]);
      expect(existsSync(path.join(target.path, 'node_modules'))).toBe(false);
    });

    it('copies ignored files that .worktreeinclude names, keeping copies the branch has', async () => {
      await put(target.repoRoot, INCLUDE_FILE, '.env\nconfig/\nnode_modules/\n');
      await put(target.repoRoot, '.env', 'SECRET=1\n');
      await put(target.repoRoot, 'config/local.json', '{}\n');
      await put(target.repoRoot, 'big.log', 'not listed\n');
      await put(target.repoRoot, 'node_modules/pkg/index.js', 'left to the clone step\n');
      await put(target.path, 'config/local.json', '{"branch":true}\n');
      expect(await setUpWorktree(testExec, target, {})).toStrictEqual([]);
      expect(await readFile(path.join(target.path, '.env'), 'utf8')).toBe('SECRET=1\n');
      expect(await readFile(path.join(target.path, 'config/local.json'), 'utf8')).toBe(
        '{"branch":true}\n',
      );
      expect(existsSync(path.join(target.path, 'big.log'))).toBe(false);
      expect(existsSync(path.join(target.path, 'node_modules'))).toBe(false);
    });

    it('clones node_modules only when every lockfile matches', async () => {
      await put(target.repoRoot, 'node_modules/pkg/index.js', 'module\n');
      await symlink('pkg/index.js', path.join(target.repoRoot, 'node_modules', 'bin-link'));
      expect(await setUpWorktree(testExec, target, {})).toStrictEqual([]);
      expect(existsSync(path.join(target.path, 'node_modules'))).toBe(false);
      await put(target.repoRoot, 'package-lock.json', 'v1\n');
      await put(target.repoRoot, 'yarn.lock', 'y1\n');
      await put(target.path, 'package-lock.json', 'v1\n');
      expect(await setUpWorktree(testExec, target, {})).toStrictEqual([]);
      expect(existsSync(path.join(target.path, 'node_modules'))).toBe(false);
      await put(target.path, 'yarn.lock', 'y2\n');
      expect(await setUpWorktree(testExec, target, {})).toStrictEqual([]);
      expect(existsSync(path.join(target.path, 'node_modules'))).toBe(false);
      await put(target.path, 'yarn.lock', 'y1\n');
      expect(await setUpWorktree(testExec, target, {})).toStrictEqual([]);
      expect(await readFile(path.join(target.path, 'node_modules/pkg/index.js'), 'utf8')).toBe(
        'module\n',
      );
      expect(await readFile(path.join(target.path, 'node_modules/bin-link'), 'utf8')).toBe(
        'module\n',
      );
      await put(target.repoRoot, 'node_modules/pkg/index.js', 'changed\n');
      expect(await setUpWorktree(testExec, target, {})).toStrictEqual([]);
      expect(await readFile(path.join(target.path, 'node_modules/pkg/index.js'), 'utf8')).toBe(
        'module\n',
      );
    });

    it('copies node_modules file by file when the macOS clone fails', async () => {
      await put(target.repoRoot, 'package-lock.json', 'v1\n');
      await put(target.path, 'package-lock.json', 'v1\n');
      await put(target.repoRoot, 'node_modules/pkg/index.js', 'module\n');
      const calls: string[][] = [];
      const broken = scriptedExec([(): ExecResult => fail('clonefileat: nope')], calls);
      expect(await setUpWorktree(broken, target, {}, 'darwin')).toStrictEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe('-e');
      expect(await readFile(path.join(target.path, 'node_modules/pkg/index.js'), 'utf8')).toBe(
        'module\n',
      );
      expect(await readdir(dir)).toStrictEqual(['repo', 'wt']);
    });

    // The system call number only means clonefileat on macOS.
    it.runIf(process.platform === 'darwin')('clones node_modules whole on macOS', async () => {
      await put(target.repoRoot, 'package-lock.json', 'v1\n');
      await put(target.path, 'package-lock.json', 'v1\n');
      await put(target.repoRoot, 'node_modules/pkg/index.js', 'module\n');
      const codes: number[] = [];
      const watched: Exec = async (command, args, options) => {
        const result = await testExec(command, args, options);
        codes.push(result.code);
        return result;
      };
      expect(await setUpWorktree(watched, target, {}, 'darwin')).toStrictEqual([]);
      expect(codes).toStrictEqual([0]);
      expect(await readFile(path.join(target.path, 'node_modules/pkg/index.js'), 'utf8')).toBe(
        'module\n',
      );
      expect(await readdir(dir)).toStrictEqual(['repo', 'wt']);
    });

    it('keeps a node_modules the session installed while the clone ran', async () => {
      await put(target.repoRoot, 'package-lock.json', 'v1\n');
      await put(target.path, 'package-lock.json', 'v1\n');
      await put(target.repoRoot, 'node_modules/pkg/index.js', 'cloned\n');
      // The session installs its own while the clone runs, and the clone then falls back to copying.
      const racing: Exec = async () => {
        await put(target.path, 'node_modules/pkg/index.js', 'installed\n');
        return fail('clonefileat: nope');
      };
      expect(await setUpWorktree(racing, target, {}, 'darwin')).toStrictEqual([]);
      expect(await readFile(path.join(target.path, 'node_modules/pkg/index.js'), 'utf8')).toBe(
        'installed\n',
      );
      expect(await readdir(dir)).toStrictEqual(['repo', 'wt']);
    });

    it('warns when the clone cannot move in and nothing else took its place', async () => {
      await put(target.repoRoot, 'package-lock.json', 'v1\n');
      await put(target.path, 'package-lock.json', 'v1\n');
      await put(target.repoRoot, 'node_modules/pkg/index.js', 'cloned\n');
      // The worktree is removed while the clone runs, so there is nowhere to move it.
      const removing: Exec = async () => {
        await rm(target.path, { recursive: true, force: true });
        return fail('clonefileat: nope');
      };
      const warnings = await setUpWorktree(removing, target, {}, 'darwin');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^Cloning node_modules failed: ENOENT/u);
      expect(await readdir(dir)).toStrictEqual(['repo']);
    });

    it('runs the setup script with the worktree variables and reports a failure', async () => {
      await put(target.path, SETUP_SCRIPT, 'echo "$OVERLORD_SLOT" > slot.txt\n');
      expect(await setUpWorktree(testExec, target, { OVERLORD_SLOT: '4' })).toStrictEqual([]);
      expect(await readFile(path.join(target.path, 'slot.txt'), 'utf8')).toBe('4\n');
      await put(target.path, SETUP_SCRIPT, 'echo nope >&2\nexit 3\n');
      expect(await setUpWorktree(testExec, target, {})).toStrictEqual([
        `Running ${SETUP_SCRIPT} failed: ${SETUP_SCRIPT} exited 3: nope`,
      ]);
    });

    it('turns a failed step into a warning and keeps going', async () => {
      await put(target.repoRoot, INCLUDE_FILE, '.env\n');
      await put(target.path, SETUP_SCRIPT, 'true\n');
      const exec = scriptedExec([
        (args): ExecResult => (args[0] === 'ls-files' ? fail('broken index') : ok()),
      ]);
      expect(await setUpWorktree(exec, target, {})).toStrictEqual([
        `Copying ${INCLUDE_FILE} files failed: git ls-files failed: broken index`,
      ]);
      const thrower = scriptedExec([
        (): ExecResult => {
          throw new Error('exec broke');
        },
      ]);
      expect(await setUpWorktree(thrower, target, {})).toStrictEqual([
        `Copying ${INCLUDE_FILE} files failed: exec broke`,
        `Running ${SETUP_SCRIPT} failed: exec broke`,
      ]);
    });
  });
});
