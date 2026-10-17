import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ApiRequest } from '../../../shared/model.js';
import { EventBus } from '../../bus.js';
import { loadCatalog } from '../../knobs/catalog.js';
import { OverlordStore } from '../../store/store.js';
import { EMPTY_USAGE } from '../../surfaces/usage.js';
import type { ProjectView } from '../projects.js';
import {
  makeEnv,
  NOW,
  permissionRequest,
  session,
  sorted,
  toolCall,
  writeJson,
  writeText,
  immediateScheduler,
} from '../test-helpers/fixtures.js';

import {
  buildFleet,
  fleetHealth,
  NEW_SESSION_TITLE,
  normalizeRateLimits,
  toFraction,
  withJobStates,
  withLiveStates,
  windowSession,
  withPlanLimits,
} from './fleet.js';
import { buildKnobs, EMPTY_KNOBS, loadKnobs, loadProfiles } from './knobs.js';
import { loadUsage } from './usage.js';

function noProjects(): ProjectView {
  return { projects: [], sessionProjects: {}, workspaceProjects: [] };
}

function store(bus: EventBus): OverlordStore {
  return new OverlordStore(bus, { scheduler: immediateScheduler });
}

describe('fleet view', () => {
  it('picks the newest session in the window folder, then the newest under it', () => {
    const repo = path.join(path.sep, 'repos', 'app');
    const nested = path.join(repo, '.claude', 'worktrees', 'x');
    const sessions = [
      session('old', { cwd: repo, updatedAt: 1 }),
      session('new', { cwd: repo, updatedAt: 5 }),
      session('wt-old', { cwd: nested, updatedAt: 2 }),
      session('wt-new', { cwd: nested, updatedAt: 9 }),
      session('sibling', { cwd: `${repo}-other`, updatedAt: 20 }),
    ];
    expect(windowSession(sessions, repo)).toBe('new');
    expect(windowSession(sessions, repo + path.sep)).toBe('new');
    expect(windowSession(sessions, nested)).toBe('wt-new');
    expect(windowSession(sessions.slice(2), repo)).toBe('wt-new');
    expect(windowSession(sessions, path.join(path.sep, 'elsewhere'))).toBeNull();
    expect(windowSession(sessions, null)).toBeNull();
  });

  it('highlights the focused terminal session, else the window session', () => {
    const bus = new EventBus();
    const fleetStore = store(bus);
    bus.emit('session.upserted', session('mine', { cwd: '/repos/app' }));
    const inputs = {
      store: fleetStore,
      pending: [],
      now: NOW,
      plan: null,
      places: {},
      activeSessionId: null,
      activeVersion: 3,
      workspaceFolder: '/repos/app',
      workspaceFolders: [],
      jobs: [],
      projects: noProjects,
      statuses: {},
    };
    expect(buildFleet(inputs).activeSessionId).toBe('mine');
    expect(buildFleet(inputs).activeVersion).toBe(3);
    expect(buildFleet({ ...inputs, activeSessionId: 'tab' }).activeSessionId).toBe('tab');
  });

  it('lets a pending permission, then Claude Code busy or idle, beat the transcript', () => {
    const sessions = [
      session('asked', { state: 'running' }),
      session('working', { state: 'waiting' }),
      session('stopped', { state: 'running' }),
      session('blocked', { state: 'waiting' }),
      session('quiet', { state: 'idle' }),
      session('unlisted', { state: 'running' }),
      session('prompted', { state: 'running' }),
    ];
    const live = withLiveStates(
      sessions,
      {
        asked: 'busy',
        working: 'busy',
        stopped: 'idle',
        blocked: 'idle',
        quiet: 'idle',
        prompted: 'waiting',
      },
      [permissionRequest('p1', { sessionId: 'asked' })],
    );
    expect(live.map((item) => item.state)).toStrictEqual([
      'waiting',
      'running',
      'idle',
      'waiting',
      'idle',
      'running',
      'waiting',
    ]);
    // Rows whose state stays the same are the same objects, so nothing re-renders for them.
    expect(live[4]).toBe(sessions[4]);
    expect(live[5]).toBe(sessions[5]);
  });

  it('turns percentages into fractions and leaves fractions and nulls alone', () => {
    expect(toFraction(null)).toBeNull();
    expect(toFraction(0.4)).toBeCloseTo(0.4, 10);
    expect(toFraction(1)).toBe(1);
    expect(toFraction(40)).toBeCloseTo(0.4, 10);
    expect(normalizeRateLimits({ fiveHourPct: 55, sevenDayPct: 0.2, resetsAt: 9 })).toStrictEqual({
      fiveHourPct: 0.55,
      sevenDayPct: 0.2,
      resetsAt: 9,
    });
  });

  it('uses the given pending list and the store for the rest', () => {
    const bus = new EventBus();
    const fleetStore = store(bus);
    bus.emit('session.upserted', session('s1'));
    bus.emit('permission.requested', permissionRequest('stale'));
    bus.emit('rateLimits.updated', { fiveHourPct: 80, sevenDayPct: null, resetsAt: null });
    const pending = [permissionRequest('live')];
    const places = { s1: 'vscode' as const };
    const state = buildFleet({
      store: fleetStore,
      pending,
      now: NOW,
      plan: null,
      places,
      activeSessionId: 's1',
      activeVersion: 0,
      workspaceFolder: null,
      workspaceFolders: [],
      jobs: [],
      projects: noProjects,
      statuses: {},
    });
    expect(state.activeSessionId).toBe('s1');
    expect(state.sessions.map((item) => item.id)).toStrictEqual(['s1']);
    expect(state.pendingPermissions).toBe(pending);
    expect(state.rateLimits).toStrictEqual({ fiveHourPct: 0.8, sevenDayPct: null, resetsAt: null });
    expect(state.places).toBe(places);
    expect(state.spendPerHourUsd).toBe(0);
    expect(state.agents).toStrictEqual([]);
    expect(sorted(Object.keys(state))).toStrictEqual([
      'activeSessionId',
      'activeVersion',
      'agents',
      'health',
      'pendingPermissions',
      'places',
      'projects',
      'rateLimits',
      'sessionProjects',
      'sessions',
      'spendPerHourUsd',
      'workspaceProjects',
    ]);
  });

  it('rates the health of each unfinished session from its main thread', () => {
    const bus = new EventBus();
    const fleetStore = store(bus);
    const request: ApiRequest = {
      messageId: 'm1',
      requestId: null,
      sessionId: 'tired',
      agentId: 'sub',
      model: 'claude-opus-5-5',
      timestamp: NOW,
      usage: { input: 900_000, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 },
      ttftMs: null,
      durationMs: null,
      costUsd: null,
    };
    for (const id of ['worn', 'tired', 'fine', 'over', 'quiet']) {
      bus.emit('session.upserted', session(id, { state: id === 'over' ? 'done' : 'idle' }));
    }
    for (const id of ['worn', 'tired', 'fine', 'over']) {
      bus.emit('tool.upserted', toolCall(id, id, `t-${id}`, {}));
    }
    // A subagent's work and compactions do not count against the session.
    bus.emit('tool.upserted', toolCall('fine', 'sub', 't-sub', {}));
    bus.emit('request.recorded', request);
    bus.emit('request.recorded', {
      ...request,
      messageId: 'm2',
      sessionId: 'fine',
      agentId: 'fine',
      usage: { ...request.usage, input: 10 },
    });
    bus.emit('compaction.recorded', { sessionId: 'fine', agentId: 'sub', at: NOW });
    bus.emit('compaction.recorded', { sessionId: 'tired', agentId: 'tired', at: NOW });
    for (const id of ['worn', 'over', 'quiet']) {
      bus.emit('compaction.recorded', { sessionId: id, agentId: id, at: NOW });
      bus.emit('compaction.recorded', { sessionId: id, agentId: id, at: NOW + 1 });
    }
    expect(fleetHealth(fleetStore, fleetStore.fleetState(NOW).sessions)).toStrictEqual({
      worn: 'degraded',
      tired: 'watch',
    });
  });

  it('marks finished jobs done and gives a job with no transcript a bare row', () => {
    const bus = new EventBus();
    const fleetStore = store(bus);
    bus.emit('session.upserted', session('live'));
    bus.emit('session.upserted', session('finished', { state: 'idle', model: 'opus' }));
    const jobs = [
      { sessionId: 'finished', name: 'Ran', cwd: '/a', startedAt: 1, state: 'done' as const },
      { sessionId: 'gone', name: null, cwd: null, startedAt: null, state: 'failed' as const },
    ];
    const state = buildFleet({
      store: fleetStore,
      pending: [],
      now: NOW,
      plan: null,
      places: {},
      activeSessionId: null,
      activeVersion: 0,
      workspaceFolder: null,
      workspaceFolders: [],
      jobs,
      projects: noProjects,
      statuses: {},
    });
    const byId = new Map(state.sessions.map((item) => [item.id, item]));
    expect(byId.get('live')?.state).toBe('running');
    expect(byId.get('finished')).toStrictEqual(
      session('finished', { state: 'done', model: 'opus' }),
    );
    expect(byId.get('gone')).toStrictEqual(
      session('gone', {
        title: NEW_SESSION_TITLE,
        cwd: '',
        state: 'failed',
        startedAt: 0,
        updatedAt: 0,
      }),
    );
  });

  it('hands back the same sessions when no job applies', () => {
    const sessions = [session('a', { state: 'done' })];
    expect(withJobStates(sessions, [])).toBe(sessions);
    const job = { sessionId: 'a', name: 'A', cwd: '/w', startedAt: 5, state: 'done' as const };
    expect(withJobStates(sessions, [job])[0]).toBe(sessions[0]);
    // A finished job with no transcript never got a prompt or aged out, so it gets no row.
    expect(withJobStates([], [job])).toStrictEqual([]);
    expect(withJobStates([], [{ ...job, state: 'waiting' }])).toStrictEqual([
      session('a', { title: 'A', cwd: '/w', state: 'waiting', startedAt: 5, updatedAt: 5 }),
    ]);
    // A new session waiting for its first prompt has no name from Claude Code yet.
    expect(withJobStates([], [{ ...job, name: null, state: 'waiting' }])[0]?.title).toBe(
      NEW_SESSION_TITLE,
    );
  });

  it('takes the session and weekly rows from the plan over rate limit events', () => {
    const bus = new EventBus();
    const fleetStore = store(bus);
    bus.emit('rateLimits.updated', { fiveHourPct: 80, sevenDayPct: 30, resetsAt: 5 });
    const plan = {
      subscription: 'max',
      limits: [
        { kind: 'session', label: 'Current session', percent: 1, resetsAt: 9, severity: 'normal' },
        {
          kind: 'weekly_all',
          label: 'Current week (all models)',
          percent: 45,
          resetsAt: 99,
          severity: 'normal',
        },
      ],
      fetchedAt: NOW,
    };
    expect(
      buildFleet({
        store: fleetStore,
        pending: [],
        now: NOW,
        plan,
        places: {},
        activeSessionId: null,
        activeVersion: 0,
        workspaceFolder: null,
        workspaceFolders: [],
        jobs: [],
        projects: noProjects,
        statuses: {},
      }).rateLimits,
    ).toStrictEqual({
      fiveHourPct: 0.01,
      sevenDayPct: 0.45,
      resetsAt: 9,
    });
  });

  it('keeps event limits for whatever the plan leaves out', () => {
    const limits = { fiveHourPct: 0.8, sevenDayPct: 0.3, resetsAt: 5 };
    expect(withPlanLimits(limits, null)).toStrictEqual(limits);
    const weekOnly = {
      subscription: null,
      limits: [
        { kind: 'weekly_all', label: 'Week', percent: 50, resetsAt: null, severity: 'normal' },
      ],
      fetchedAt: NOW,
    };
    expect(withPlanLimits(limits, weekOnly)).toStrictEqual({
      fiveHourPct: 0.8,
      sevenDayPct: 0.5,
      resetsAt: 5,
    });
  });
});

describe('knobs view', () => {
  it('loads effective values for the workspace and feature flags', async () => {
    const env = await makeEnv({ workspace: true });
    const workspace = env.host.workspace ?? '';
    await writeJson(env.paths.userSettings, { model: 'opus', cleanupPeriodDays: 3 });
    await writeJson(path.join(workspace, '.claude', 'settings.json'), { model: 'sonnet' });
    await writeJson(env.paths.claudeJson, {
      cachedGrowthBookFeatures: { flag: true },
      userID: 'x',
    });
    const report = vi.fn<(source: string, message: string) => void>();
    const data = await loadKnobs({
      paths: env.paths,
      env: { CLAUDE_CODE_X: '1' },
      workspace,
      report,
    });
    const model = data.effective.find((item) => item.key === 'model');
    expect(model?.value).toBe('sonnet');
    expect(model?.layer).toBe('project');
    expect(data.effective.find((item) => item.key === 'env.CLAUDE_CODE_X')?.value).toBe('1');
    expect(data.files.map((file) => [file.layer, file.exists, file.keys])).toStrictEqual([
      ['managed', false, 0],
      ['project-local', false, 0],
      ['project', true, 1],
      ['user', true, 2],
    ]);
    expect(data.featureFlags).toStrictEqual({ cachedGrowthBookFeatures: { flag: true } });
    expect(report).not.toHaveBeenCalled();
  });

  it('reports broken settings and flag files but still returns what it could read', async () => {
    const env = await makeEnv();
    await writeText(env.paths.userSettings, '{bad');
    await writeText(env.paths.claudeJson, '{bad');
    const report = vi.fn<(source: string, message: string) => void>();
    const data = await loadKnobs({ paths: env.paths, env: {}, workspace: null, report });
    expect(data.effective).toStrictEqual([]);
    expect(data.featureFlags).toStrictEqual({});
    expect(data.files.map((file) => [file.layer, file.exists, file.keys])).toStrictEqual([
      ['managed', false, 0],
      ['user', true, 0],
    ]);
    expect(data.files[1]?.error).toContain('Invalid JSON');
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls.map((call) => call[0])).toStrictEqual(['knobs', 'knobs']);
    expect(String(report.mock.calls[0]?.[1])).toContain('Invalid JSON');
  });

  it('loads profiles and reports a broken profile store', async () => {
    const env = await makeEnv();
    const file = path.join(env.storageDir, 'profiles.json');
    const report = vi.fn<(source: string, message: string) => void>();
    await expect(loadProfiles(file, report)).resolves.toStrictEqual([]);
    expect(report).not.toHaveBeenCalled();
    await writeText(file, 'nope');
    await expect(loadProfiles(file, report)).resolves.toStrictEqual([]);
    expect(report).toHaveBeenCalledWith('profiles', expect.stringContaining('Invalid JSON'));
  });

  it('builds the state with the bundled catalog', () => {
    const profiles = [
      {
        id: 'p',
        name: 'P',
        model: null,
        effort: null,
        permissionMode: null,
        env: {},
        extraArgs: [],
      },
    ];
    const files = [{ layer: 'user' as const, file: '/u.json', exists: true, keys: 2, error: null }];
    const state = buildKnobs({ effective: [], files, featureFlags: { a: 1 } }, profiles);
    expect(state.catalog).toBe(loadCatalog());
    expect(state.catalog.length).toBeGreaterThan(100);
    expect(state.profiles).toBe(profiles);
    expect(state.featureFlags).toStrictEqual({ a: 1 });
    expect(state.effective).toStrictEqual([]);
    expect(state.files).toBe(files);
    expect(EMPTY_KNOBS).toStrictEqual({ effective: [], files: [], featureFlags: {} });
  });
});

describe('usage view', () => {
  it('reads stats-cache.json and falls back to empty usage', async () => {
    const env = await makeEnv();
    const report = vi.fn<(source: string, message: string) => void>();
    await expect(loadUsage(env.paths, report)).resolves.toStrictEqual(EMPTY_USAGE);
    await writeJson(env.paths.statsCache, {
      version: 2,
      dailyActivity: [{ date: '2026-10-01', messageCount: 3, sessionCount: 1, toolCallCount: 2 }],
      totalSessions: 1,
      totalMessages: 3,
    });
    const usage = await loadUsage(env.paths, report);
    expect(usage.totalMessages).toBe(3);
    expect(usage.days.map((day) => day.date)).toStrictEqual(['2026-10-01']);
    expect(report).not.toHaveBeenCalled();
    await writeText(env.paths.statsCache, '{bad');
    await expect(loadUsage(env.paths, report)).resolves.toStrictEqual(EMPTY_USAGE);
    expect(report).toHaveBeenCalledWith('usage', expect.any(String));
  });
});
