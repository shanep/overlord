// Config repo commands: turn on sync (sign in to GitHub, find or create the
// repo, clone it and set this machine up), push, pull and the one-time
// dot-files import. Every step that changes files on this machine shows what
// it will do first and asks.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentSyncTarget } from '../sync/agent-plan.js';
import { bootstrapNewMachine } from '../sync/bootstrap.js';
import { listDir, readTextOrNull } from '../sync/files.js';
import type { GitAuth, StatusEntry } from '../sync/git.js';
import {
  aheadBehind,
  clone,
  commitAll,
  hasCommits,
  pull,
  push,
  remoteUrl,
  statusPorcelain,
} from '../sync/git.js';
import {
  CONFIG_REPO_NAME,
  findOrCreateRepo,
  gitHubAuthEnv,
  isGitHubHttps,
} from '../sync/github.js';
import { planImportFromDotfiles } from '../sync/import-dotfiles.js';
import { collapseHome, remoteSlug } from '../sync/layout.js';
import { emptyManifest, writeManifest } from '../sync/manifest.js';
import { scanForSecrets } from '../sync/secrets.js';

import { changeCount, confirmAndApply } from './apply-plan.js';
import type { HostPort } from './host-port.js';
import { runMemorySync } from './memory.js';
import type { Runtime } from './runtime.js';
import { syncTargets } from './sync-targets.js';
import { plural } from './text.js';
import { configRepoDir, connectedRoot } from './views/config.js';

export const NOT_CONNECTED = 'Turn on config sync first.';
export const SIGN_IN_MESSAGE = 'Config sync needs you to sign in to GitHub.';

/** The README a new config repo starts with, naming each agent that syncs and where its files land. */
export function readmeText(targets: readonly AgentSyncTarget[], home: string): string {
  const others = targets.map(
    (target) =>
      `- ${target.name}: agents/${target.agent}/, with its own overlord.json, lands in ${collapseHome(target.dir, home)}`,
  );
  return [
    '# Agent config',
    '',
    'Overlord keeps this repo in sync with each coding agent on every machine it',
    'runs on. Edit the files through the agent folders as usual. Overlord commits,',
    'pulls and pushes in the background.',
    '',
    '- Claude Code: overlord.json, global/ and the folders next to it land in ~/.claude',
    ...others,
    '',
    'Settings files are synced key by key, so the agent can keep writing its own',
    'keys. Sign in files, sessions, history and logs never come here.',
    '',
  ].join('\n');
}

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

/**
 * Credentials for the config repo's remote: the editor's GitHub token for an
 * https github.com URL, or the user's own git setup (SSH, a credential helper)
 * for anything else. Null when GitHub needs a sign in that did not happen.
 */
export async function gitAuthFor(
  host: HostPort,
  url: string | null,
  interactive: boolean,
): Promise<{ readonly auth: GitAuth } | null> {
  if (url === null || !isGitHubHttps(url)) {
    return { auth: null };
  }
  const session = await host.gitHubSession(interactive);
  return session === null ? null : { auth: gitHubAuthEnv(session.accessToken) };
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

  /**
   * The one step a machine needs, like turning on VS Code's Settings Sync.
   * With no URL configured it signs in to GitHub through the editor, finds
   * the user's overlord-config repo or creates it private, and saves its URL.
   * A new repo gets a starter manifest. An existing one is set up here after a
   * dry run. From then on ConfigSync keeps it in step in the background.
   */
  async turnOn(): Promise<void> {
    const { host } = this.rt;
    const dir = repoDir(this.rt);
    const root = (await connectedRoot(this.rt.exec, dir)) ?? (await this.cloneInto(dir));
    if (root === null) {
      return;
    }
    const url = await remoteUrl(this.rt.exec, root);
    const configured = host.settings.configRepoUrl.trim();
    if (url === null || (configured !== '' && !sameRepo(url, configured))) {
      host.showError(`${dir} holds a different repo. Change overlord.configRepo.path or move it.`);
      return;
    }
    if (configured === '') {
      await host.saveSetting('configRepo.url', url);
    }
    if (!(await hasCommits(this.rt.exec, root))) {
      await this.seed(root);
    }
    await this.setUpMachine(url, root);
    await this.rt.configSync.syncNow();
  }

  /** Clones the configured repo, or the user's GitHub one, into dir. Null when that cannot happen. */
  private async cloneInto(dir: string): Promise<string | null> {
    const { host } = this.rt;
    const entries = await listDir(dir);
    if (entries.length > 0) {
      host.showError(`${dir} exists and is not a git clone.`);
      return null;
    }
    const url = await this.repoUrl();
    if (url === null) {
      return null;
    }
    const signIn = await gitAuthFor(host, url, true);
    if (signIn === null) {
      host.showError(SIGN_IN_MESSAGE);
      return null;
    }
    await mkdir(path.dirname(dir), { recursive: true });
    await clone(this.rt.exec, url, dir, signIn.auth);
    return dir;
  }

  /** The configured URL, or the user's GitHub config repo, made when there is none. */
  private async repoUrl(): Promise<string | null> {
    const { host } = this.rt;
    const configured = host.settings.configRepoUrl.trim();
    if (configured !== '') {
      return configured;
    }
    const session = await host.gitHubSession(true);
    if (session === null) {
      host.showError(SIGN_IN_MESSAGE);
      return null;
    }
    const repo = await findOrCreateRepo(this.rt.fetch, session.accessToken, CONFIG_REPO_NAME);
    host.showInfo(
      repo.created
        ? `Created the private repo ${repo.fullName} for your Claude config.`
        : `Found your config repo ${repo.fullName}.`,
    );
    return repo.cloneUrl;
  }

  /** A first commit for an empty repo, so every machine has a manifest to read. */
  private async seed(root: string): Promise<void> {
    await writeManifest(root, emptyManifest());
    await writeFile(
      path.join(root, 'README.md'),
      readmeText(syncTargets(this.rt), this.rt.paths.home),
    );
    await commitAll(this.rt.exec, root, `Start the config repo from ${this.rt.hostname}`);
  }

  /** Clone the repo's external repos and apply its manifest here, after a dry run. */
  private async setUpMachine(url: string, root: string): Promise<void> {
    const signIn = await gitAuthFor(this.rt.host, url, true);
    const result = await bootstrapNewMachine({
      repoUrl: url,
      dest: root,
      paths: this.rt.paths,
      host: this.rt.hostname,
      deps: { exec: this.rt.exec, auth: signIn?.auth ?? null },
      agents: syncTargets(this.rt),
    });
    if (changeCount(result.actions) > 0) {
      await confirmAndApply(this.rt, result.actions, []);
    }
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
    const signIn = await gitAuthFor(this.rt.host, await remoteUrl(this.rt.exec, root), true);
    if (signIn === null) {
      this.rt.host.showError(SIGN_IN_MESSAGE);
      return;
    }
    await push(this.rt.exec, root, 'origin', signIn.auth);
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
    const signIn = await gitAuthFor(this.rt.host, await remoteUrl(this.rt.exec, root), true);
    if (signIn === null) {
      this.rt.host.showError(SIGN_IN_MESSAGE);
      return;
    }
    await pull(this.rt.exec, root, signIn.auth);
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
}
