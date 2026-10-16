// Runs a plan. Every backup in the plan happens first, into
// ~/.claude/backups/overlord-<timestamp>/, and nothing that exists is ever
// overwritten or removed unless it was backed up in this run (symlinks are
// the exception: removing a link leaves the data it points at alone).

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ClaudePaths } from '../paths.js';

import type { Action } from './actions.js';
import type { Exec } from './exec.js';
import { copyPath, isInside, lstatOrNull, pathExists } from './files.js';
import { clone } from './git.js';
import { resolveSecretsInText, type SecretStore } from './secrets.js';

export interface ApplyDeps {
  readonly exec: Exec;
  readonly secrets: SecretStore;
  readonly paths: ClaudePaths;
  readonly now: () => Date;
  /** Symlinks become copies on Windows, where links need extra rights. */
  readonly platform: NodeJS.Platform;
}

export interface ApplyResult {
  /** Where this run's backups went, or null when nothing needed one. */
  readonly backupDir: string | null;
  readonly performed: readonly Action[];
  readonly failed: { readonly action: Action; readonly message: string } | null;
}

const COMMAND_TIMEOUT_MS = 300_000;

export function backupDirName(now: Date): string {
  return `overlord-${now.toISOString().replaceAll(':', '-').replace('.', '-')}`;
}

/** Where a path lands inside a backup folder: relative to home, or under _root/ when outside it. */
export function backupLocation(backupDir: string, target: string, home: string): string {
  const resolved = path.resolve(target);
  if (isInside(resolved, home) && resolved !== path.resolve(home)) {
    return path.join(backupDir, path.relative(home, resolved));
  }
  return path.join(backupDir, '_root', path.relative(path.parse(resolved).root, resolved));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Failure = ApplyResult['failed'];

interface BackupOutcome {
  readonly dir: string | null;
  readonly failed: Failure;
}

class Runner {
  readonly backedUp = new Set<string>();
  readonly deps: ApplyDeps;

  constructor(deps: ApplyDeps) {
    this.deps = deps;
  }

  /** Clear the way for a new file at `target`. */
  async clear(target: string): Promise<void> {
    const info = await lstatOrNull(target);
    if (info === null) {
      return;
    }
    if (!info.isSymbolicLink() && !this.backedUp.has(path.resolve(target))) {
      throw new Error(`Refusing to replace ${target}: it was not backed up first`);
    }
    await rm(target, { recursive: true, force: true });
  }

  async place(target: string, write: () => Promise<void>): Promise<void> {
    await this.clear(target);
    await mkdir(path.dirname(target), { recursive: true });
    await write();
  }

  async runCommand(command: string, args: readonly string[]): Promise<void> {
    const filled: string[] = [];
    const missing: string[] = [];
    for (const part of args) {
      const resolved = await resolveSecretsInText(part, this.deps.secrets);
      filled.push(resolved.text);
      missing.push(...resolved.missing);
    }
    if (missing.length > 0) {
      throw new Error(`Missing secrets: ${missing.join(', ')}`);
    }
    const result = await this.deps.exec(command, filled, { timeoutMs: COMMAND_TIMEOUT_MS });
    if (result.code !== 0) {
      throw new Error(`${command} exited ${String(result.code)}: ${result.stderr.trim()}`);
    }
  }

  async link(source: string, target: string): Promise<void> {
    const windows = this.deps.platform === 'win32';
    await this.place(target, async () =>
      windows ? copyPath(source, target) : symlink(source, target),
    );
  }

  async cloneExternal(repoUrl: string, destination: string): Promise<void> {
    if (await pathExists(destination)) {
      return;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await clone(this.deps.exec, repoUrl, destination);
  }

  async perform(action: Action): Promise<void> {
    switch (action.kind) {
      case 'mkdir': {
        await mkdir(action.path, { recursive: true });
        return;
      }
      case 'link': {
        await this.link(action.source, action.target);
        return;
      }
      case 'copy': {
        await this.place(action.target, async () => copyPath(action.source, action.target));
        return;
      }
      case 'generate-settings':
      case 'write-file': {
        await this.place(action.target, async () => writeFile(action.target, action.content));
        return;
      }
      case 'remove': {
        await this.clear(action.path);
        return;
      }
      case 'run-command': {
        await this.runCommand(action.command, action.args);
        return;
      }
      case 'clone-external': {
        await this.cloneExternal(action.repoUrl, action.destination);
        return;
      }
      case 'backup':
      case 'note': {
        return;
      }
    }
  }

  /** Copy every existing target into one backup folder. Stops at the first copy that fails. */
  async backup(targets: readonly string[]): Promise<BackupOutcome> {
    const existing: string[] = [];
    for (const target of targets) {
      if (await pathExists(target)) {
        existing.push(path.resolve(target));
      }
    }
    if (existing.length === 0) {
      return { dir: null, failed: null };
    }
    const { paths } = this.deps;
    const dir = path.join(paths.configDir, 'backups', backupDirName(this.deps.now()));
    for (const target of existing) {
      const destination = backupLocation(dir, target, paths.home);
      try {
        await mkdir(path.dirname(destination), { recursive: true });
        await copyPath(target, destination);
      } catch (error: unknown) {
        return {
          dir,
          failed: { action: { kind: 'backup', path: target }, message: messageOf(error) },
        };
      }
      this.backedUp.add(target);
    }
    return { dir, failed: null };
  }
}

/** Back up, then perform each action in order, stopping at the first failure. */
export async function applyPlan(actions: readonly Action[], deps: ApplyDeps): Promise<ApplyResult> {
  const runner = new Runner(deps);
  const backups = actions.flatMap((action) => (action.kind === 'backup' ? [action.path] : []));
  const { dir: backupDir, failed } = await runner.backup([...new Set(backups)]);
  if (failed !== null) {
    return { backupDir, performed: [], failed };
  }
  const performed: Action[] = [];
  for (const action of actions) {
    try {
      await runner.perform(action);
    } catch (error: unknown) {
      return { backupDir, performed, failed: { action, message: messageOf(error) } };
    }
    if (action.kind !== 'note') {
      performed.push(action);
    }
  }
  return { backupDir, performed, failed: null };
}
