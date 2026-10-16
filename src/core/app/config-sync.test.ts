import { lstat, readFile, readlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Exec } from '../sync/exec.js';
import { git, isolatedExec } from '../sync/test-helpers/fixtures.js';

import { ConfigSync, LOCAL_CHECK_MS } from './config-sync.js';
import type { IntervalFunction } from './process.js';
import { NOT_CONNECTED, SIGN_IN_MESSAGE } from './sync-commands.js';
import type { TestEnv } from './test-helpers/fixtures.js';
import { cloneConfigRepo, makeApp, makeEnv, NOW, writeText } from './test-helpers/fixtures.js';

const KEY = `sk-ant-${'a'.repeat(30)}`;

const LINKED_CLAUDE_MD = JSON.stringify({
  version: 1,
  memory: { enabled: false },
  items: [
    {
      id: 'claude-md',
      kind: 'claude-md',
      source: 'global/CLAUDE.md',
      target: '~/.claude/CLAUDE.md',
      mode: 'link',
    },
  ],
});

interface Machines {
  readonly env: TestEnv;
  readonly exec: Exec;
  /** This machine's clone at ~/.claude-config. */
  readonly repo: string;
  readonly remote: string;
  /** Another machine's clone of the same remote. */
  readonly other: string;
  readonly sync: ConfigSync;
}

const MANIFEST_ONLY: Readonly<Record<string, string>> = { 'overlord.json': '{"version":1}\n' };

async function machines(
  files: Readonly<Record<string, string>> = MANIFEST_ONLY,
  settings: Parameters<typeof makeEnv>[0] = {},
): Promise<Machines> {
  const env = await makeEnv(settings);
  const exec = isolatedExec();
  const repo = await cloneConfigRepo(env, exec, files);
  const url = await git(exec, repo, ['remote', 'get-url', 'origin']);
  const remote = url.trim();
  const other = path.join(env.root, 'other');
  await git(exec, env.root, ['clone', '-q', remote, other]);
  const { app } = makeApp(env, { deps: { exec } });
  return { env, exec, repo, remote, other, sync: new ConfigSync(app.runtime) };
}

async function commitOn(
  exec: Exec,
  clone: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await writeText(path.join(clone, file), text);
  }
  await git(exec, clone, ['add', '-A']);
  await git(exec, clone, ['commit', '-q', '-m', 'from the other machine']);
  await git(exec, clone, ['push', '-q']);
}

async function log(exec: Exec, repo: string): Promise<string[]> {
  const out = await git(exec, repo, ['log', '--format=%s']);
  return out.trim().split('\n');
}

interface Timer {
  readonly callback: () => void;
  readonly ms: number;
}

function recordingInterval(timers: Timer[], stops: string[]): IntervalFunction {
  const stop = (): void => {
    stops.push('stopped');
  };
  return (callback, ms) => {
    timers.push({ callback, ms });
    return stop;
  };
}

const GITHUB_URL = 'https://github.com/me/c.git';

describe('ConfigSync', () => {
  it('commits and pushes local changes in the background without asking', async () => {
    const { env, exec, repo, remote, sync } = await machines();
    await writeText(path.join(repo, 'agents', 'a.md'), '# a\n');
    await sync.tick();
    expect(await log(exec, remote)).toStrictEqual(['Update config from test-host', 'first']);
    expect(env.host.questions).toStrictEqual([]);
    expect(env.host.infos).toStrictEqual([]);
    expect(sync.status()).toStrictEqual({ state: 'idle', lastSyncAt: NOW, message: null });
  });

  it('leaves the remote alone on a quiet minute and pushes as soon as something changes', async () => {
    const { env, exec, repo, sync } = await machines();
    await sync.tick();
    await git(exec, repo, ['remote', 'set-url', 'origin', path.join(env.root, 'gone.git')]);
    await sync.tick();
    expect(env.host.errors).toStrictEqual([]);
    await writeText(path.join(repo, 'b.txt'), 'b\n');
    await sync.tick();
    expect(env.host.errors).toHaveLength(1);
    expect(env.host.errors[0]).toMatch(/fetch --quiet failed/u);
    expect(sync.status().state).toBe('error');
  });

  it("pulls another machine's change and links its new items", async () => {
    const { env, exec, other, repo, sync } = await machines();
    await commitOn(exec, other, {
      'overlord.json': LINKED_CLAUDE_MD,
      'global/CLAUDE.md': '# shared\n',
    });
    await sync.tick();
    expect(await readlink(env.paths.userClaudeMd)).toBe(path.join(repo, 'global', 'CLAUDE.md'));
    expect(env.host.asks).toStrictEqual([]);
    expect(env.host.errors).toStrictEqual([]);
  });

  it('asks before a pulled change replaces a file on this machine', async () => {
    const { env, exec, other, repo, sync } = await machines();
    await writeText(env.paths.userClaudeMd, '# mine\n');
    await commitOn(exec, other, {
      'overlord.json': LINKED_CLAUDE_MD,
      'global/CLAUDE.md': '# shared\n',
    });
    env.host.askAnswers.push('Review');
    env.host.confirmAnswers.push(true);
    await sync.tick();
    await vi.waitFor(async () => {
      expect(await readlink(env.paths.userClaudeMd)).toBe(path.join(repo, 'global', 'CLAUDE.md'));
    });
    expect(env.host.asks).toStrictEqual([
      {
        message: 'Config sync pulled 2 changes that would replace things on this machine.',
        actions: ['Review'],
      },
    ]);
  });

  it('replays local commits on top of remote ones', async () => {
    const { exec, other, repo, remote, sync } = await machines();
    await commitOn(exec, other, { 'theirs.txt': 'theirs\n' });
    await writeText(path.join(repo, 'mine.txt'), 'mine\n');
    await sync.tick();
    expect(await log(exec, remote)).toStrictEqual([
      'Update config from test-host',
      'from the other machine',
      'first',
    ]);
    expect(await readFile(path.join(repo, 'theirs.txt'), 'utf8')).toBe('theirs\n');
  });

  it('pauses on a conflict, leaves no rebase behind and reports it once', async () => {
    const { env, exec, other, repo, sync } = await machines({
      'overlord.json': '{"version":1}\n',
      'notes.txt': 'base\n',
    });
    await commitOn(exec, other, { 'notes.txt': 'theirs\n' });
    await writeText(path.join(repo, 'notes.txt'), 'mine\n');
    await sync.tick();
    await sync.tick();
    const message = `Config sync paused: this machine and another one changed the same lines. Resolve it in ${repo}.`;
    expect(env.host.errors).toStrictEqual([message]);
    expect(sync.status()).toMatchObject({ state: 'error', message });
    await expect(lstat(path.join(repo, '.git', 'rebase-merge'))).rejects.toThrow();
    expect(await readFile(path.join(repo, 'notes.txt'), 'utf8')).toBe('mine\n');
    await sync.syncNow();
    expect(env.host.errors).toStrictEqual([message, message]);
  });

  it('stops before committing a file that looks like a secret', async () => {
    const { env, exec, repo, sync } = await machines();
    await writeText(path.join(repo, 'mcp.json'), `{"token":"${KEY}"}\n`);
    await sync.tick();
    expect(env.host.errors).toStrictEqual([
      'Config sync paused: mcp.json line 1 looks like a secret (anthropic-key).',
    ]);
    expect(await log(exec, repo)).toStrictEqual(['first']);
  });

  it('asks for a GitHub sign in before touching an https GitHub remote', async () => {
    const { env, exec, repo, sync } = await machines();
    await git(exec, repo, ['remote', 'set-url', 'origin', GITHUB_URL]);
    await sync.tick();
    expect(env.host.gitHubRequests).toStrictEqual([false]);
    expect(env.host.asks).toStrictEqual([{ message: SIGN_IN_MESSAGE, actions: ['Sign in'] }]);
    expect(sync.status().message).toBe(SIGN_IN_MESSAGE);
  });

  it('runs Sign in from the notice as an interactive sync', async () => {
    const { env, exec, repo, sync } = await machines();
    await git(exec, repo, ['remote', 'set-url', 'origin', GITHUB_URL]);
    env.host.askAnswers.push('Sign in');
    await sync.tick();
    await vi.waitFor(() => {
      expect(env.host.gitHubRequests).toStrictEqual([false, true]);
    });
  });

  it('syncs once when the window comes to the front, then waits a minute', async () => {
    const { env, exec, repo, sync } = await machines();
    await git(exec, repo, ['remote', 'set-url', 'origin', GITHUB_URL]);
    await sync.windowFocused();
    await sync.windowFocused();
    expect(env.host.gitHubRequests).toStrictEqual([false]);
  });

  it('runs one sync at a time: background checks skip, Sync now takes turns', async () => {
    const { env, exec, repo, remote, sync } = await machines();
    await writeText(path.join(repo, 'a.txt'), 'a\n');
    await Promise.all([sync.syncNow(), sync.tick(), sync.syncNow(), sync.syncNow()]);
    expect(env.host.infos).toStrictEqual(['Config synced.', 'Config synced.', 'Config synced.']);
    expect(await log(exec, remote)).toStrictEqual(['Update config from test-host', 'first']);
  });

  it('pulls into a repo with no manifest without applying anything', async () => {
    const { env, exec, other, repo, sync } = await machines({ 'README.md': 'x\n' });
    await commitOn(exec, other, { 'b.txt': 'b\n' });
    await sync.tick();
    expect(env.host.errors).toStrictEqual([]);
    expect(await readFile(path.join(repo, 'b.txt'), 'utf8')).toBe('b\n');
  });

  it('reports a pulled change it cannot put in place', async () => {
    const { env, exec, other, sync } = await machines();
    await writeText(path.join(env.home, 'blocker'), 'a file, not a folder\n');
    const manifest = JSON.parse(LINKED_CLAUDE_MD) as { items: { target: string }[] };
    manifest.items[0] = { ...manifest.items[0], target: '~/blocker/CLAUDE.md' };
    await commitOn(exec, other, {
      'overlord.json': JSON.stringify(manifest),
      'global/CLAUDE.md': '# shared\n',
    });
    await sync.tick();
    expect(env.host.errors).toHaveLength(1);
    expect(env.host.errors[0]).toMatch(/^Config sync could not apply a pulled change: /u);
  });

  it('leaves this machine alone when the review is dismissed', async () => {
    const { env, exec, other, sync } = await machines();
    await writeText(env.paths.userClaudeMd, '# mine\n');
    await commitOn(exec, other, {
      'overlord.json': LINKED_CLAUDE_MD,
      'global/CLAUDE.md': '# shared\n',
    });
    await sync.tick();
    await vi.waitFor(() => {
      expect(env.host.asks).toHaveLength(1);
    });
    expect(env.host.opened).toStrictEqual([]);
    expect(await readFile(env.paths.userClaudeMd, 'utf8')).toBe('# mine\n');
  });

  it('stays quiet in the background when turned off, and Sync now still runs', async () => {
    const { env, exec, repo, remote, sync } = await machines(undefined, {
      settings: { configSyncAuto: false },
    });
    await writeText(path.join(repo, 'a.txt'), 'a\n');
    await sync.tick();
    await sync.windowFocused();
    expect(sync.status().state).toBe('off');
    expect(await log(exec, remote)).toStrictEqual(['first']);
    await sync.syncNow();
    expect(await log(exec, remote)).toStrictEqual(['Update config from test-host', 'first']);
    expect(env.host.infos).toStrictEqual(['Config synced.']);
  });

  it('waits for another window holding the lock, and takes over a stale one', async () => {
    const { env, exec, repo, remote, sync } = await machines();
    const lock = path.join(repo, '.git', 'overlord-sync.lock');
    await writeFile(lock, '');
    await writeText(path.join(repo, 'a.txt'), 'a\n');
    await sync.tick();
    expect(env.host.infos).toStrictEqual([]);
    await sync.syncNow();
    expect(env.host.infos).toStrictEqual([
      'Another window is syncing the config repo. Try again in a moment.',
    ]);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lock, old, old);
    await sync.syncNow();
    expect(await log(exec, remote)).toStrictEqual(['Update config from test-host', 'first']);
    await expect(lstat(lock)).rejects.toThrow();
  });

  it('needs a connected repo', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env, { deps: { exec: isolatedExec() } });
    const sync = new ConfigSync(app.runtime);
    await sync.tick();
    expect(env.host.infos).toStrictEqual([]);
    await sync.syncNow();
    await app.dispatch({ type: 'syncNow' }, {});
    expect(env.host.infos).toStrictEqual([NOT_CONNECTED, NOT_CONNECTED]);
  });

  it('checks every minute once started, and the config view shows its status', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env, { deps: { exec: isolatedExec() } });
    const sync = new ConfigSync(app.runtime);
    const timers: Timer[] = [];
    const stops: string[] = [];
    const stop = sync.start(recordingInterval(timers, stops));
    expect(timers.map((timer) => timer.ms)).toStrictEqual([LOCAL_CHECK_MS]);
    timers[0]?.callback();
    app.windowFocused();
    stop();
    expect(stops).toStrictEqual(['stopped']);
    const view = app.stateFor('config', {});
    expect(view.view === 'config' && view.state.sync).toStrictEqual({
      state: 'idle',
      lastSyncAt: null,
      message: null,
    });
  });
});
