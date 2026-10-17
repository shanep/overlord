// Background config sync, the way VS Code's Settings Sync works: once the
// config repo is connected, local changes are committed and pushed and remote
// ones pulled and applied without asking. A quick local check runs every
// minute, and a full sync runs at start, when the window comes to the front
// and every overlord.configSync.intervalMinutes. Only a pulled change that
// would overwrite something on this machine still asks first.

import { open, rm } from 'node:fs/promises';
import path from 'node:path';

import type { ConfigSyncStatus } from '../../shared/protocol.js';
import type { Action } from '../sync/actions.js';
import { applyPlan } from '../sync/apply.js';
import { statOrNull } from '../sync/files.js';
import {
  aheadBehind,
  commitAll,
  fetch,
  push,
  rebaseOntoUpstream,
  remoteUrl,
  statusPorcelain,
} from '../sync/git.js';
import { readManifest } from '../sync/manifest.js';
import { planAll } from '../sync/plan.js';

import { applyDeps, changeCount, confirmAndApply } from './apply-plan.js';
import { messageOf } from './errors.js';
import { runMemorySync } from './memory.js';
import type { IntervalFunction } from './process.js';
import type { Runtime } from './runtime.js';
import { gitAuthFor, NOT_CONNECTED, secretInChanges, SIGN_IN_MESSAGE } from './sync-commands.js';
import { syncTargets } from './sync-targets.js';
import { plural } from './text.js';
import { configRepoDir, connectedRoot, IDLE_SYNC } from './views/config.js';

export const LOCAL_CHECK_MS = 60_000;
const MINUTE_MS = 60_000;
const FOCUS_THROTTLE_MS = MINUTE_MS;
// Another window's sync holds the lock for seconds. One left by a crash is stale.
const LOCK_STALE_MS = 10 * MINUTE_MS;
const LOCK_FILE = 'overlord-sync.lock';

const SIGN_IN = 'Sign in';
const REVIEW = 'Review';

// Steps that only add things this machine does not have yet. Anything else
// (a backup before an overwrite, a removal, a claude command) asks first.
const QUIET_KINDS: ReadonlySet<Action['kind']> = new Set([
  'mkdir',
  'link',
  'copy',
  'write-file',
  'generate-settings',
  'clone-external',
  'note',
]);

/** A sync that stopped on purpose, with what the user should be told. */
class SyncStop extends Error {
  constructor(
    message: string,
    readonly action: string | null = null,
  ) {
    super(message);
    this.name = 'SyncStop';
  }
}

// Every window runs its own Overlord, so a lock file in the clone's .git
// folder keeps two of them from committing or rebasing at once.
async function takeLock(file: string): Promise<boolean> {
  try {
    const handle = await open(file, 'wx');
    await handle.close();
    return true;
  } catch {
    const info = await statOrNull(file);
    // The lock's age is real file time, so it is compared with the real clock.
    if (info === null || Date.now() - info.mtimeMs < LOCK_STALE_MS) {
      return false;
    }
    await rm(file, { force: true });
    return takeLock(file);
  }
}

interface RunOptions {
  /** Fetch, pull and push, not just commit what changed here. */
  readonly remote: boolean;
  /** The user asked, so sign in may prompt and every outcome is reported. */
  readonly interactive: boolean;
}

export class ConfigSync {
  private current: ConfigSyncStatus = IDLE_SYNC;
  private pending: Promise<void> | null = null;
  private lastRemoteAt = Number.NEGATIVE_INFINITY;
  private lastFocusAt = Number.NEGATIVE_INFINITY;
  /** The last message shown, so a background sync failing the same way stays quiet. */
  private lastNotice: string | null = null;

  constructor(private readonly rt: Runtime) {}

  status(): ConfigSyncStatus {
    const idle = this.current.state === 'idle';
    return idle && !this.rt.host.settings.configSyncAuto
      ? { ...this.current, state: 'off' }
      : this.current;
  }

  /** Starts the timer and the first full sync. Returns the stop function. */
  start(interval: IntervalFunction): () => void {
    const stop = interval(() => {
      void this.tick();
    }, LOCAL_CHECK_MS);
    void this.tick();
    return stop;
  }

  /** The window came to the front, which is when another machine's changes matter. */
  async windowFocused(): Promise<void> {
    const now = this.rt.clock();
    if (now - this.lastFocusAt < FOCUS_THROTTLE_MS) {
      return;
    }
    this.lastFocusAt = now;
    await this.background(true);
  }

  async syncNow(): Promise<void> {
    await this.run({ remote: true, interactive: true });
  }

  /** One timer tick: a full sync once the interval has passed, else a local check. */
  async tick(): Promise<void> {
    const minutes = Math.max(1, this.rt.host.settings.configSyncIntervalMinutes);
    await this.background(this.rt.clock() - this.lastRemoteAt >= minutes * MINUTE_MS);
  }

  private async background(remote: boolean): Promise<void> {
    if (this.rt.host.settings.configSyncAuto) {
      await this.run({ remote, interactive: false });
    }
  }

  private async run(options: RunOptions): Promise<void> {
    // A background check never queues behind another sync. Sync now waits its
    // turn, and checks again after waking, since another caller may have gone first.
    while (this.pending !== null) {
      if (!options.interactive) {
        return;
      }
      await this.pending;
    }
    this.pending = this.attempt(options);
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async attempt(options: RunOptions): Promise<void> {
    const { rt } = this;
    const dir = configRepoDir(rt.host.settings.configRepoPath, rt.paths.home);
    const root = await connectedRoot(rt.exec, dir);
    if (root === null) {
      if (options.interactive) {
        rt.host.showInfo(NOT_CONNECTED);
      }
      return;
    }
    const lock = path.join(root, '.git', LOCK_FILE);
    if (!(await takeLock(lock))) {
      if (options.interactive) {
        rt.host.showInfo('Another window is syncing the config repo. Try again in a moment.');
      }
      return;
    }
    if (options.remote) {
      this.lastRemoteAt = rt.clock();
      this.setStatus({ ...this.current, state: 'syncing' });
    }
    let review: readonly Action[] = [];
    try {
      review = await this.steps(root, options);
      this.succeed(options);
    } catch (error: unknown) {
      this.fail(error, options);
    } finally {
      await rm(lock, { force: true });
      await rt.caches.config.refresh();
    }
    if (review.length > 0) {
      void this.offerReview(review);
    }
  }

  /** Commit, then on a remote run fetch, rebase, push and apply. Returns the plan that needs a yes. */
  private async steps(root: string, options: RunOptions): Promise<readonly Action[]> {
    const { rt } = this;
    const quiet = !options.interactive;
    if (options.remote) {
      await runMemorySync(rt, root, { quiet });
    }
    const changes = await statusPorcelain(rt.exec, root);
    const leak = await secretInChanges(root, changes);
    if (leak !== null) {
      throw new SyncStop(`Config sync paused: ${leak}`);
    }
    if (changes.length > 0) {
      await commitAll(rt.exec, root, `Update config from ${rt.hostname}`);
    }
    const local = await aheadBehind(rt.exec, root);
    if (!options.remote && local.ahead === 0) {
      return [];
    }
    if (!(await this.pushAndPull(root, options.interactive))) {
      return [];
    }
    await runMemorySync(rt, root, { quiet });
    return this.applyIncoming(root);
  }

  /** Fetch, replay local commits on what came in, and push. True when something came in. */
  private async pushAndPull(root: string, interactive: boolean): Promise<boolean> {
    const { rt } = this;
    const signIn = await gitAuthFor(rt.host, await remoteUrl(rt.exec, root), interactive);
    if (signIn === null) {
      throw new SyncStop(SIGN_IN_MESSAGE, SIGN_IN);
    }
    await fetch(rt.exec, root, signIn.auth);
    const counts = await aheadBehind(rt.exec, root);
    const pulled = counts.hasUpstream && counts.behind > 0;
    if (pulled && !(await rebaseOntoUpstream(rt.exec, root))) {
      throw new SyncStop(
        `Config sync paused: this machine and another one changed the same lines. Resolve it in ${root}.`,
      );
    }
    if (!counts.hasUpstream || counts.ahead > 0) {
      await push(rt.exec, root, 'origin', signIn.auth);
    }
    return pulled;
  }

  /** Puts what another machine added in place. Returns the plan when it would overwrite something. */
  private async applyIncoming(root: string): Promise<readonly Action[]> {
    const { rt } = this;
    const read = await readManifest(root);
    if (!read.ok) {
      return [];
    }
    const place = { paths: rt.paths, host: rt.hostname, agents: syncTargets(rt) };
    const actions = await planAll(read.manifest, root, place);
    if (changeCount(actions) === 0) {
      return [];
    }
    if (!actions.every((action) => QUIET_KINDS.has(action.kind))) {
      return actions;
    }
    const result = await applyPlan(actions, applyDeps(rt));
    if (result.failed !== null) {
      throw new SyncStop(`Config sync could not apply a pulled change: ${result.failed.message}`);
    }
    return [];
  }

  private async offerReview(actions: readonly Action[]): Promise<void> {
    const count = plural(changeCount(actions), 'change');
    const message = `Config sync pulled ${count} that would replace things on this machine.`;
    if ((await this.rt.host.ask(message, [REVIEW])) === REVIEW) {
      await confirmAndApply(this.rt, actions, []);
    }
  }

  private succeed(options: RunOptions): void {
    this.lastNotice = null;
    if (options.remote || this.current.state === 'error') {
      this.setStatus({ state: 'idle', lastSyncAt: this.rt.clock(), message: null });
    }
    if (options.interactive) {
      this.rt.host.showInfo('Config synced.');
    }
  }

  private fail(error: unknown, options: RunOptions): void {
    const message = messageOf(error);
    this.setStatus({ ...this.current, state: 'error', message });
    if (!options.interactive && message === this.lastNotice) {
      return;
    }
    this.lastNotice = message;
    const action = error instanceof SyncStop ? error.action : null;
    if (action === null) {
      this.rt.host.showError(message);
    } else {
      void this.offerSignIn(message, action);
    }
  }

  private async offerSignIn(message: string, action: string): Promise<void> {
    if ((await this.rt.host.ask(message, [action])) === SIGN_IN) {
      await this.syncNow();
    }
  }

  private setStatus(next: ConfigSyncStatus): void {
    this.current = next;
    this.rt.notify();
  }
}
