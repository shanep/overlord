// Config repo commands: connect a clone, push, pull, the one-time dot-files
// import and new machine setup. Every step that changes files shows what it
// will do first and asks.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { bootstrapNewMachine } from '../sync/bootstrap.js';
import { pathExists, readTextOrNull } from '../sync/files.js';
import type { StatusEntry } from '../sync/git.js';
import {
  aheadBehind,
  clone,
  commitAll,
  pull,
  push,
  remoteUrl,
  statusPorcelain,
} from '../sync/git.js';
import { planImportFromDotfiles } from '../sync/import-dotfiles.js';
import { remoteSlug } from '../sync/layout.js';
import { scanForSecrets } from '../sync/secrets.js';

import { confirmAndApply } from './apply-plan.js';
import { runMemorySync } from './memory.js';
import type { Runtime } from './runtime.js';
import { plural } from './text.js';
import { configRepoDir, connectedRoot } from './views/config.js';

export const NOT_CONNECTED = 'Connect a config repo first.';

function repoDir(rt: Runtime): string {
  return configRepoDir(rt.host.settings.configRepoPath, rt.paths.home);
}

/** The clone's root, or null after telling the user to connect one. */
async function requireRoot(rt: Runtime): Promise<string | null> {
  const root = await connectedRoot(rt.exec, repoDir(rt));
  if (root === null) {
    rt.host.showInfo(NOT_CONNECTED);
  }
  return root;
}

function sameRepo(left: string, right: string): boolean {
  const slug = remoteSlug(left);
  return slug === null ? left === right : slug === remoteSlug(right);
}

/** The first changed file that looks like it holds a token, as a message. */
export async function secretInChanges(
  root: string,
  changes: readonly StatusEntry[],
): Promise<string | null> {
  for (const change of changes) {
    const text = await readTextOrNull(path.join(root, change.path));
    const finding = text === null ? undefined : scanForSecrets(text)[0];
    if (finding !== undefined) {
      return `${change.path} line ${String(finding.line)} looks like a secret (${finding.rule}).`;
    }
  }
  return null;
}

export class SyncCommands {
  constructor(private readonly rt: Runtime) {}

  /** Clone the config repo, or adopt a clone that is already there. */
  async connectConfigRepo(): Promise<void> {
    const { host } = this.rt;
    const entered = await host.inputBox({
      prompt: 'Git URL of your config repo',
      value: host.settings.configRepoUrl,
    });
    const url = entered?.trim() ?? '';
    if (url === '') {
      return;
    }
    const dir = repoDir(this.rt);
    const root = await connectedRoot(this.rt.exec, dir);
    if (root !== null) {
      const remote = await remoteUrl(this.rt.exec, root);
      if (remote === null || !sameRepo(remote, url)) {
        host.showError(
          `${dir} holds a different repo. Change overlord.configRepo.path or move it.`,
        );
        return;
      }
      host.showInfo(`Connected to the clone in ${dir}.`);
    } else if (await pathExists(dir)) {
      host.showError(`${dir} exists and is not a git clone.`);
      return;
    } else {
      if (!(await host.confirm(`Clone ${url} into ${dir}?`, 'Clone'))) {
        return;
      }
      await mkdir(path.dirname(dir), { recursive: true });
      await clone(this.rt.exec, url, dir);
      host.showInfo(`Cloned the config repo into ${dir}.`);
    }
    await this.rt.caches.config.refresh();
  }

  async push(): Promise<void> {
    const root = await requireRoot(this.rt);
    if (root === null) {
      return;
    }
    const question = 'Sync auto memory, commit every change in the config repo and push it?';
    if (!(await this.rt.host.confirm(question, 'Push'))) {
      return;
    }
    await runMemorySync(this.rt, root);
    const changes = await statusPorcelain(this.rt.exec, root);
    const leak = await secretInChanges(root, changes);
    if (leak !== null) {
      this.rt.host.showError(`Push stopped: ${leak}`);
      return;
    }
    const counts = await aheadBehind(this.rt.exec, root);
    if (changes.length === 0 && counts.ahead === 0) {
      this.rt.host.showInfo('Nothing to push.');
      return;
    }
    if (changes.length > 0) {
      await commitAll(this.rt.exec, root, `Update config from ${this.rt.hostname}`);
    }
    await push(this.rt.exec, root);
    this.rt.host.showInfo(`Pushed the config repo (${plural(changes.length, 'changed file')}).`);
    await this.rt.caches.config.refresh();
  }

  async pull(): Promise<void> {
    const root = await requireRoot(this.rt);
    if (root === null) {
      return;
    }
    if (!(await this.rt.host.confirm('Pull the latest config from the remote?', 'Pull'))) {
      return;
    }
    await pull(this.rt.exec, root);
    await runMemorySync(this.rt, root);
    this.rt.host.showInfo('Pulled the config repo.');
    await this.rt.caches.config.refresh();
  }

  /** The one-time move of a dot-files claude folder into the config repo. */
  async importDotfiles(): Promise<void> {
    const root = await requireRoot(this.rt);
    if (root === null) {
      return;
    }
    const folder = await this.rt.host.pickFolder('Pick the claude folder in your dot-files repo');
    if (folder === null) {
      return;
    }
    const plan = await planImportFromDotfiles(folder, root, this.rt.paths, this.rt.hostname);
    const skipped = plan.skipped.map((entry) => `skipped ${entry.path}: ${entry.reason}`);
    await confirmAndApply(this.rt, plan.actions, skipped);
    await this.rt.caches.config.refresh();
  }

  /** New machine setup: clone the repo and its externals, then apply the manifest. */
  async bootstrap(): Promise<void> {
    const { host } = this.rt;
    const configured = host.settings.configRepoUrl.trim();
    const entered =
      configured === ''
        ? await host.inputBox({ prompt: 'Git URL of your config repo', value: '' })
        : configured;
    const url = entered?.trim() ?? '';
    if (url === '') {
      return;
    }
    const destination = repoDir(this.rt);
    if (
      !(await host.confirm(
        `Clone ${url} into ${destination} if needed and plan the setup?`,
        'Continue',
      ))
    ) {
      return;
    }
    const result = await bootstrapNewMachine({
      repoUrl: url,
      dest: destination,
      paths: this.rt.paths,
      host: this.rt.hostname,
      deps: { exec: this.rt.exec },
    });
    const applied = await confirmAndApply(this.rt, result.actions, []);
    if (applied?.failed === null) {
      await runMemorySync(this.rt, destination);
    }
    await this.rt.caches.config.refresh();
  }
}
