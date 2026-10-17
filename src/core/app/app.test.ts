import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { VIEW_IDS } from '../../shared/protocol.js';
import { EventBus } from '../bus.js';
import { installHooks } from '../hooks/install.js';
import { encodeMessage } from '../hooks/protocol.js';
import type { ExecResult } from '../sync/exec.js';
import { userPrompt } from '../transcripts/test-helpers/fixtures.js';

import { concurrencyFrom, OverlordApp, SESSIONS_REFRESH_MS } from './app.js';
import { cliLoader, executableFor } from './claude-bin.js';
import { FakeHost } from './test-helpers/fake-host.js';
import {
  makeApp,
  makeEnv,
  NOW,
  ok,
  session,
  settle,
  shortSocketPath,
  waitFor,
  writeJson,
  writeText,
} from './test-helpers/fixtures.js';
import { PLAN_STALE_MS } from './views/usage.js';

async function installOurHooks(settingsFile: string): Promise<void> {
  await installHooks({ settingsFile, hookCommand: 'node "/ext/dist/overlord-hook.cjs"' });
}

async function telemetrySettings(settingsFile: string): Promise<void> {
  await writeJson(settingsFile, {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    },
  });
}

async function busyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function waitForPort(app: OverlordApp): Promise<number> {
  await waitFor(() => app.telemetryPort !== null);
  return app.telemetryPort ?? 0;
}

describe('helpers', () => {
  it('finds a bare claude on the login shell PATH', async () => {
    const env = await makeEnv();
    const bin = path.join(env.root, 'bin');
    const claude = await writeText(path.join(bin, 'claude'), '#!/bin/sh\n');
    await chmod(claude, 0o755);
    const shellEnv = { PATH: `/nowhere:${bin}` };
    expect(executableFor('claude', shellEnv, 'darwin')).toBe(claude);
    expect(executableFor('  ', shellEnv, 'linux')).toBe(claude);
  });

  it('leaves the SDK its bundled CLI only when claude is nowhere on PATH', () => {
    expect(executableFor('claude', { PATH: '/nowhere' }, 'darwin')).toBeNull();
    expect(executableFor('claude', {}, 'darwin')).toBeNull();
  });

  it('passes other names and paths through as given', () => {
    expect(executableFor(' /opt/claude ', {}, 'darwin')).toBe('/opt/claude');
    expect(executableFor('claude-dev', { PATH: '/nowhere' }, 'linux')).toBe('claude-dev');
  });

  it('resolves the CLI against the login environment with the current setting', async () => {
    const settings = { claudePath: 'claude' };
    const load = cliLoader(
      settings,
      async () => {
        await Promise.resolve();
        return { PATH: '/nowhere', GONE: undefined };
      },
      'linux',
    );
    expect(await load()).toStrictEqual({ bin: 'claude', env: { PATH: '/nowhere' } });
    settings.claudePath = '/opt/claude';
    const changed = await load();
    expect(changed.bin).toBe('/opt/claude');
  });

  it('keeps concurrency a whole number of at least one', () => {
    expect(concurrencyFrom(4)).toBe(4);
    expect(concurrencyFrom(2.6)).toBe(3);
    expect(concurrencyFrom(0)).toBe(1);
    expect(concurrencyFrom(-3)).toBe(1);
    expect(concurrencyFrom(Number.NaN)).toBe(1);
    expect(SESSIONS_REFRESH_MS).toBe(30_000);
  });
});

describe('OverlordApp', () => {
  it('fills in real defaults without touching the disk until started', async () => {
    const env = await makeEnv();
    const app = new OverlordApp({ host: new FakeHost({ storageDir: env.storageDir }) });
    expect(app.paths.home).toBe(os.homedir());
    expect(app.bus).toBeInstanceOf(EventBus);
    expect(app.runtime.hostname).toBe(os.hostname());
    expect(app.runtime.platform).toBe(process.platform);
    expect(app.runtime.env).toBe(process.env);
    expect(app.runtime.clock()).toBeGreaterThan(0);
    expect(app.runtime.isAlive(process.pid)).toBe(true);
    expect(app.runtime.launcher.maxConcurrency).toBe(4);
    await app.dispose();
    await app.start();
    expect(app.runtime.store.fleetState(0).sessions).toStrictEqual([]);
  });

  it('starts the watcher, timers and settings watches once, and stops them on dispose', async () => {
    const env = await makeEnv({ workspace: true });
    const line = JSON.stringify({ ...userPrompt('u1', 0, 'hello'), sessionId: 'abc' });
    await writeText(path.join(env.paths.projectsDir, '-work', 'abc.jsonl'), `${line}\n`);
    const { app, intervals, watches, calls } = makeApp(env, {
      responders: [(): ExecResult => ok('[]')],
      deps: { clock: () => Date.now() },
    });
    await app.start();
    await app.start();
    expect(intervals.map((entry) => entry.ms)).toStrictEqual([
      30_000, 1000, 10_000, 60_000, 600_000, 60_000, 30_000, 5000, 60_000,
    ]);
    const workspace = env.host.workspace ?? '';
    expect(watches.map((entry) => entry.file)).toStrictEqual([
      env.paths.userSettings,
      path.join(workspace, '.claude', 'settings.json'),
      path.join(workspace, '.claude', 'settings.local.json'),
      path.join(env.storageDir, 'projects.json'),
    ]);
    expect(app.runtime.store.fleetState(Date.now()).sessions.map((item) => item.id)).toStrictEqual([
      'abc',
    ]);
    intervals[0]?.callback();
    // The sessions cache asks for live agents only; the jobs poll adds --all.
    await waitFor(() =>
      calls.some((call) => call.args.includes('agents') && !call.args.includes('--all')),
    );
    expect(calls.filter((call) => call.args.includes('--all'))).toHaveLength(1);
    const placesRefresh = vi.spyOn(app.runtime.places, 'refresh');
    intervals[1]?.callback();
    expect(placesRefresh).toHaveBeenCalledTimes(1);
    const jobsRefresh = vi.spyOn(app.runtime.jobs, 'refresh');
    intervals[2]?.callback();
    expect(jobsRefresh).toHaveBeenCalledTimes(1);
    const connectorsRefresh = vi.spyOn(app.runtime.caches.connectors, 'refresh');
    intervals[4]?.callback();
    expect(connectorsRefresh).toHaveBeenCalledTimes(1);
    const budgetsWarned = vi.spyOn(app.runtime.budgets, 'warned');
    intervals[6]?.callback();
    expect(budgetsWarned).not.toHaveBeenCalled();
    const projectsRefresh = vi.spyOn(app.runtime.projects, 'refresh');
    intervals[7]?.callback();
    expect(projectsRefresh).toHaveBeenCalledTimes(1);
    const projectsLoad = vi.spyOn(app.runtime.projects, 'load');
    watches[3]?.onChange();
    expect(projectsLoad).toHaveBeenCalledTimes(1);
    const status = await app.setup.status();
    expect(status).toStrictEqual({
      hooksInstalled: false,
      telemetryEnabled: false,
      observerMode: false,
      errors: [],
    });
    const storeDispose = vi.spyOn(app.runtime.store, 'dispose');
    await Promise.all([app.dispose(), app.dispose()]);
    await app.dispose();
    expect(storeDispose).toHaveBeenCalledTimes(1);
    expect(intervals.every((entry) => entry.stopped)).toBe(true);
    expect(watches.every((entry) => entry.stopped)).toBe(true);
  });

  it('points the fleet at the session in the focused terminal', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    const active = (): string | null => {
      const message = app.stateFor('fleet', {});
      return message.view === 'fleet' ? message.state.activeSessionId : null;
    };
    expect(active()).toBeNull();
    app.setActiveTerminal({ sessionId: 'abc', processId: 42 });
    expect(active()).toBe('abc');
    const version = (): number => {
      const message = app.stateFor('fleet', {});
      return message.view === 'fleet' ? message.state.activeVersion : -1;
    };
    const before = version();
    app.runtime.places.windowFocused();
    expect(version()).toBe(before + 1);
    await app.dispose();
  });

  it('drops a session from the fleet once it leaves the active window', async () => {
    const env = await makeEnv();
    const line = JSON.stringify({ ...userPrompt('u1', 0, 'hello'), sessionId: 'abc' });
    await writeText(path.join(env.paths.projectsDir, '-work', 'abc.jsonl'), `${line}\n`);
    let now = Date.now();
    const { app } = makeApp(env, { deps: { clock: () => now } });
    await app.start();
    const fleetIds = (): string[] => {
      const message = app.stateFor('fleet', {});
      return message.view === 'fleet' ? message.state.sessions.map((item) => item.id) : [];
    };
    expect(fleetIds()).toStrictEqual(['abc']);
    now += (env.host.settings.activeWindowMinutes + 1) * 60_000;
    await app.refresh();
    expect(fleetIds()).toStrictEqual([]);
    await app.dispose();
  });

  it('keeps a session the Launcher started past the active window, after a reload too', async () => {
    const env = await makeEnv();
    const line = JSON.stringify({ ...userPrompt('u1', 0, 'hello'), sessionId: 'abc' });
    await writeText(path.join(env.paths.projectsDir, '-work', 'abc.jsonl'), `${line}\n`);
    await writeJson(path.join(env.host.storageDir, 'launched.json'), {
      version: 1,
      sessions: ['abc'],
    });
    const now = Date.now() + (env.host.settings.activeWindowMinutes + 1) * 60_000;
    const { app } = makeApp(env, { deps: { clock: () => now } });
    await app.start();
    const message = app.stateFor('fleet', {});
    expect(
      message.view === 'fleet' ? message.state.sessions.map((item) => item.id) : [],
    ).toStrictEqual(['abc']);
    expect(message.view === 'fleet' ? message.state.launched : []).toStrictEqual(['abc']);
    await app.dispose();
  });

  it('keeps a quiet session while a terminal shows it and lets it go once the terminal closes', async () => {
    const env = await makeEnv();
    const line = JSON.stringify({ ...userPrompt('u1', 0, 'hello'), sessionId: 'abc' });
    await writeText(path.join(env.paths.projectsDir, '-work', 'abc.jsonl'), `${line}\n`);
    await writeJson(path.join(env.paths.sessionsDir, '123.json'), {
      pid: 123,
      sessionId: 'abc',
      kind: 'interactive',
    });
    let open = true;
    const now = Date.now() + (env.host.settings.activeWindowMinutes + 1) * 60_000;
    const { app } = makeApp(env, {
      deps: { clock: () => now, isAlive: (pid) => open && pid === 123 },
    });
    await app.start();
    const fleetIds = (): string[] => {
      const message = app.stateFor('fleet', {});
      return message.view === 'fleet' ? message.state.sessions.map((item) => item.id) : [];
    };
    expect(fleetIds()).toStrictEqual(['abc']);
    open = false;
    await app.refresh();
    await app.refresh();
    expect(fleetIds()).toStrictEqual([]);
    await app.dispose();
  });

  it('keeps a waiting background job until Claude Code forgets it and a finished one through the active window', async () => {
    const env = await makeEnv();
    const line = JSON.stringify({ ...userPrompt('u1', 0, 'hello'), sessionId: 'abc' });
    await writeText(path.join(env.paths.projectsDir, '-work', 'abc.jsonl'), `${line}\n`);
    const { activeWindowMinutes, idleMinutes } = env.host.settings;
    let now = Date.now() + (idleMinutes + 1) * 60_000;
    // A stopped job that never got a prompt has no transcript and no row.
    let jobs: unknown[] = [
      { sessionId: 'abc', kind: 'background', state: 'done', name: 'Ran' },
      { sessionId: 'gone', kind: 'background', state: 'stopped', name: 'Gone' },
    ];
    const { app } = makeApp(env, {
      deps: { clock: () => now },
      responders: [
        (call): ExecResult | undefined =>
          call.args.includes('--all') ? ok(JSON.stringify(jobs)) : undefined,
      ],
    });
    await app.start();
    const fleet = (): string[] => {
      const message = app.stateFor('fleet', {});
      return message.view === 'fleet'
        ? message.state.sessions.map((item) => `${item.id} ${item.state}`)
        : [];
    };
    expect(fleet()).toStrictEqual(['abc done']);
    now = Date.now() + (activeWindowMinutes + 1) * 60_000;
    await app.refresh();
    expect(fleet()).toStrictEqual([]);
    // A job asking a question stays in the fleet as waiting however long it waits.
    jobs = [{ sessionId: 'abc', kind: 'background', state: 'blocked', name: 'Ran' }];
    await app.refresh();
    expect(fleet()).toStrictEqual(['abc waiting']);
    expect(app.statusLine()).toContain('1 waiting');
    jobs = [];
    await app.refresh();
    expect(fleet()).toStrictEqual([]);
    await app.dispose();
  });

  it('reports the session in the focused terminal for the properties view', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    expect(app.activeSession()).toBeNull();
    app.setActiveTerminal({ sessionId: 'opened-here', processId: 4242 });
    expect(app.activeSession()).toBe('opened-here');
  });

  it('reads background jobs again as soon as a session goes busy or idle', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env, { deps: { isAlive: (pid) => pid === 123 } });
    await writeJson(path.join(env.paths.sessionsDir, '123.json'), {
      pid: 123,
      sessionId: 'job',
      kind: 'bg',
      status: 'busy',
    });
    const jobsRefresh = vi.spyOn(app.runtime.jobs, 'refresh');
    await app.runtime.places.refresh();
    expect(app.runtime.places.statuses).toStrictEqual({ job: 'busy' });
    expect(jobsRefresh).toHaveBeenCalledTimes(1);
  });

  it('watches only user settings without a workspace', async () => {
    const env = await makeEnv();
    const { app, watches } = makeApp(env);
    await app.start();
    expect(watches.map((entry) => entry.file)).toStrictEqual([
      env.paths.userSettings,
      path.join(env.storageDir, 'projects.json'),
    ]);
  });

  it('runs the hook server when hooks are installed and stops it when they are removed', async () => {
    const env = await makeEnv();
    await installOurHooks(env.paths.userSettings);
    const socket = shortSocketPath();
    const { app, watches } = makeApp(env, { deps: { hookSocketPath: socket } });
    await app.start();
    expect(existsSync(socket)).toBe(true);
    await expect(app.setup.status()).resolves.toMatchObject({ hooksInstalled: true });
    await writeJson(env.paths.userSettings, {});
    watches[0]?.onChange();
    await waitFor(() => !existsSync(socket));
    expect(app.errorList()).toStrictEqual([]);
  });

  it('runs in observer mode when another window owns the socket', async () => {
    const env = await makeEnv();
    await installOurHooks(env.paths.userSettings);
    const socket = shortSocketPath();
    const first = makeApp(env, { deps: { hookSocketPath: socket } });
    await first.app.start();
    const second = makeApp(env, { deps: { hookSocketPath: socket } });
    const changed = vi.fn();
    second.app.onChange(changed);
    await second.app.start();
    await expect(second.app.setup.status()).resolves.toMatchObject({ observerMode: true });
    expect(second.app.errorList()).toStrictEqual([]);
    expect(changed).toHaveBeenCalled();
    await first.app.dispose();
    await writeJson(env.paths.userSettings, {});
    second.watches[0]?.onChange();
    await settle(20);
    await expect(second.app.setup.status()).resolves.toMatchObject({ observerMode: false });
  });

  it('reports a hook server that cannot start for another reason', async () => {
    const env = await makeEnv();
    await installOurHooks(env.paths.userSettings);
    const blocker = await writeText(path.join(env.root, 'blocker'), '');
    const { app } = makeApp(env, { deps: { hookSocketPath: path.join(blocker, 'hook.sock') } });
    await app.start();
    expect(app.errorList().map((error) => error.source)).toStrictEqual(['hooks']);
    await expect(app.setup.status()).resolves.toMatchObject({ observerMode: false });
  });

  it('reports a settings file whose hooks block it cannot read', async () => {
    const env = await makeEnv();
    await writeJson(env.paths.userSettings, { hooks: 'nonsense' });
    const { app } = makeApp(env);
    await app.start();
    expect(app.errorList().map((error) => error.source)).toStrictEqual(['hooks']);
    await expect(app.setup.status()).resolves.toMatchObject({ hooksInstalled: false });
  });

  it('receives telemetry when user settings turn it on', async () => {
    const env = await makeEnv();
    await telemetrySettings(env.paths.userSettings);
    const { app, bus, watches } = makeApp(env);
    await app.start();
    const status = await app.setup.status();
    expect(status.telemetryEnabled).toBe(true);
    const port = await waitForPort(app);
    watches[0]?.onChange();
    await settle(20);
    expect(app.telemetryPort).toBe(port);
    bus.on('source.error', ({ message }) => {
      if (message.startsWith('invalid OTLP')) {
        throw new Error('listener broke');
      }
    });
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceLogs: 'wrong' }),
    });
    expect(response.status).toBe(200);
    expect(app.errorList().map((error) => `${error.source}: ${error.message}`)).toStrictEqual([
      'otel: invalid OTLP logs export',
      'otel: listener broke',
    ]);
  });

  it('reports a telemetry port that is taken', async () => {
    const env = await makeEnv({ settings: {} });
    const taken = await busyPort();
    env.host.settings = { ...env.host.settings, telemetryPort: taken.port };
    await telemetrySettings(env.paths.userSettings);
    const { app } = makeApp(env);
    await app.start();
    await taken.close();
    expect(app.errorList()).toHaveLength(1);
    expect(
      app.errorList()[0]?.message.startsWith(`Cannot listen on port ${String(taken.port)}: `),
    ).toBe(true);
  });

  it('builds every view state and tells listeners about store changes', async () => {
    const env = await makeEnv();
    const { app, bus } = makeApp(env);
    const changed = vi.fn();
    const off = app.onChange(changed);
    expect(app.stateFor('agent', {})).toMatchObject({ state: { agent: null, session: null } });
    expect(app.stateFor('properties', {})).toMatchObject({ state: { sessionId: null } });
    for (const view of VIEW_IDS) {
      const message = app.stateFor(view, { sessionId: 's1' });
      expect(message.type).toBe('state');
      expect(message.view).toBe(view);
    }
    bus.emit('session.upserted', session('s1', { title: 'Main' }));
    expect(changed).toHaveBeenCalled();
    expect(app.statusLine()).toBe('Overlord: 1 running, $0.00/h');
    expect(app.runningItems().map((item) => item.label)).toStrictEqual(['Main']);
    off();
    changed.mockClear();
    bus.emit('session.upserted', session('s2'));
    expect(changed).not.toHaveBeenCalled();
  });

  it('sends every agent with each view state, found or not', async () => {
    const env = await makeEnv();
    const bin = await writeText(path.join(env.root, 'claude'), '#!/bin/sh\n');
    await chmod(bin, 0o755);
    // Detection looks on the login shell's PATH, which starts from the app's environment.
    const { app } = makeApp(env, { deps: { env: { PATH: env.root } } });
    const before = app.stateFor('fleet', {}).agents;
    expect(before.map((agent) => [agent.id, agent.installed])).toStrictEqual([
      ['claude-code', false],
      ['codex', false],
      ['copilot', false],
    ]);
    await app.runtime.caches.agents.refresh();
    expect(app.stateFor('help', {}).agents.map((agent) => agent.installed)).toStrictEqual([
      true,
      false,
      false,
    ]);
  });

  it('refreshes everything on demand and applies new settings', async () => {
    const env = await makeEnv();
    await writeJson(env.paths.statsCache, { totalSessions: 9, totalMessages: 2 });
    const { app } = makeApp(env, { responders: [(): ExecResult => ok('[]')] });
    const changed = vi.fn();
    app.onChange(changed);
    await app.refresh();
    expect(app.stateFor('usage', {})).toMatchObject({ state: { totalSessions: 9 } });
    env.host.settings = { ...env.host.settings, maxConcurrency: 7 };
    changed.mockClear();
    app.applySettings();
    expect(app.runtime.launcher.maxConcurrency).toBe(7);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('adds plan limits to the usage view and reads them again once stale', async () => {
    const env = await makeEnv();
    let now = NOW;
    const reply = {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        limits: [{ kind: 'session', percent: 40, severity: 'normal', resets_at: null }],
      },
    };
    const planUsageFunction = vi.fn(async (): Promise<unknown> => {
      await Promise.resolve();
      return reply;
    });
    const { app } = makeApp(env, {
      deps: { planUsageFunction, clock: (): number => now, env: { HOME: '/h', UNSET: undefined } },
    });
    await app.refresh();
    expect(planUsageFunction).toHaveBeenCalledWith({
      cwd: env.paths.home,
      env: { HOME: '/h' },
      executablePath: null,
    });
    expect(app.stateFor('usage', {})).toMatchObject({
      state: { plan: { subscription: 'max', fetchedAt: NOW, limits: [{ percent: 40 }] } },
    });
    now += PLAN_STALE_MS;
    app.stateFor('usage', {});
    expect(planUsageFunction).toHaveBeenCalledTimes(1);
    now += 1;
    app.stateFor('usage', {});
    app.stateFor('usage', {});
    await waitFor(() => planUsageFunction.mock.calls.length === 2);
    await settle();
    expect(planUsageFunction).toHaveBeenCalledTimes(2);
    expect(app.stateFor('usage', {})).toMatchObject({ state: { plan: { fetchedAt: now } } });
  });

  it('routes hook events to the context view and the permission inbox', async () => {
    const env = await makeEnv();
    await installOurHooks(env.paths.userSettings);
    const socket = shortSocketPath();
    const { app, bus } = makeApp(env, { deps: { hookSocketPath: socket } });
    await app.start();
    bus.emit('session.upserted', session('s1', { cwd: env.home }));
    const client = connect(socket);
    const replies: string[] = [];
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      replies.push(chunk);
    });
    const common = { session_id: 's1', cwd: env.home };
    client.write(
      encodeMessage({
        id: 'm1',
        event: {
          ...common,
          hook_event_name: 'InstructionsLoaded',
          file_path: '/rules/hooked.md',
          memory_type: 'User',
          load_reason: 'session_start',
        },
      }),
    );
    client.write(
      encodeMessage({
        id: 'm2',
        event: {
          ...common,
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'make' },
        },
      }),
    );
    await waitFor(() => app.runtime.permissions.list().length === 1);
    const [request] = app.runtime.permissions.list();
    expect(request?.source).toBe('hook');
    app.stateFor('context', { sessionId: 's1' });
    await waitFor(() => {
      const message = app.stateFor('context', { sessionId: 's1' });
      return message.view === 'context' && (message.state.snapshot?.loaded.length ?? 0) > 0;
    });
    await app.dispatch(
      {
        type: 'resolvePermission',
        requestId: request?.id ?? '',
        decision: { behavior: 'allow', ruleId: null },
      },
      {},
    );
    await waitFor(() => replies.join('').includes('"m2"'));
    expect(replies.join('')).toContain('"behavior":"allow"');
    expect(app.runtime.permissions.list()).toStrictEqual([]);
    client.destroy();
  });

  it('passes hook events to the coordinator, which refreshes worktrees after a push', async () => {
    const env = await makeEnv();
    await installOurHooks(env.paths.userSettings);
    const socket = shortSocketPath();
    const { app } = makeApp(env, { deps: { hookSocketPath: socket } });
    await app.start();
    const refresh = vi.spyOn(app.runtime.caches.worktrees, 'refresh');
    const client = connect(socket);
    const replies: string[] = [];
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      replies.push(chunk);
    });
    const common = { session_id: 's1', cwd: env.home };
    client.write(
      encodeMessage({
        id: 'c1',
        event: { ...common, hook_event_name: 'SessionStart', source: 'startup' },
      }),
    );
    client.write(
      encodeMessage({
        id: 'c2',
        event: {
          ...common,
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git push origin HEAD:master' },
          tool_response: {},
        },
      }),
    );
    await waitFor(() => replies.join('').includes('"c2"'));
    // Alone in no repository, the session hears nothing about other sessions.
    expect(replies.join('')).not.toContain('other Claude Code sessions');
    expect(replies.join('')).toContain('{"id":"c2","output":{}}');
    expect(refresh).toHaveBeenCalled();
    client.destroy();
  });

  it('dispatches actions', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'openFile', path: '/x' }, {});
    expect(env.host.opened).toStrictEqual(['/x']);
  });

  it('skips source changes after dispose', async () => {
    const env = await makeEnv();
    const socket = shortSocketPath();
    const { app } = makeApp(env, { deps: { hookSocketPath: socket } });
    await app.start();
    await app.dispose();
    env.host.confirmAnswers.push(true);
    await app.setup.installHooks();
    expect(existsSync(socket)).toBe(false);
  });
});
