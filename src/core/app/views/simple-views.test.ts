import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../bus.js';
import { loadCatalog } from '../../knobs/catalog.js';
import { OverlordStore } from '../../store/store.js';
import { EMPTY_USAGE } from '../../surfaces/usage.js';
import {
  makeEnv,
  NOW,
  permissionRequest,
  session,
  sorted,
  writeJson,
  writeText,
  immediateScheduler,
} from '../test-helpers/fixtures.js';

import {
  buildFleet,
  normalizeRateLimits,
  toFraction,
  withJobStates,
  windowSession,
  withPlanLimits,
} from './fleet.js';
import { buildKnobs, EMPTY_KNOBS, loadKnobs, loadProfiles } from './knobs.js';
import { loadUsage } from './usage.js';

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
      jobs: [],
    };
    expect(buildFleet(inputs).activeSessionId).toBe('mine');
    expect(buildFleet(inputs).activeVersion).toBe(3);
    expect(buildFleet({ ...inputs, activeSessionId: 'tab' }).activeSessionId).toBe('tab');
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
      jobs: [],
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
      'pendingPermissions',
      'places',
      'rateLimits',
      'sessions',
      'spendPerHourUsd',
    ]);
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
      jobs,
    });
    const byId = new Map(state.sessions.map((item) => [item.id, item]));
    expect(byId.get('live')?.state).toBe('running');
    expect(byId.get('finished')).toStrictEqual(
      session('finished', { state: 'done', model: 'opus' }),
    );
    expect(byId.get('gone')).toStrictEqual(
      session('gone', { title: '', cwd: '', state: 'failed', startedAt: 0, updatedAt: 0 }),
    );
  });

  it('hands back the same sessions when no job applies', () => {
    const sessions = [session('a', { state: 'done' })];
    expect(withJobStates(sessions, [])).toBe(sessions);
    const job = { sessionId: 'a', name: 'A', cwd: '/w', startedAt: 5, state: 'done' as const };
    expect(withJobStates(sessions, [job])[0]).toBe(sessions[0]);
    expect(withJobStates([], [job])).toStrictEqual([
      session('a', { title: 'A', cwd: '/w', state: 'done', startedAt: 5, updatedAt: 5 }),
    ]);
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
        jobs: [],
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
    expect(data.featureFlags).toStrictEqual({ cachedGrowthBookFeatures: { flag: true } });
    expect(report).not.toHaveBeenCalled();
  });

  it('reports broken settings and flag files but still returns what it could read', async () => {
    const env = await makeEnv();
    await writeText(env.paths.userSettings, '{bad');
    await writeText(env.paths.claudeJson, '{bad');
    const report = vi.fn<(source: string, message: string) => void>();
    const data = await loadKnobs({ paths: env.paths, env: {}, workspace: null, report });
    expect(data).toStrictEqual({ effective: [], featureFlags: {} });
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
    const state = buildKnobs({ effective: [], featureFlags: { a: 1 } }, profiles);
    expect(state.catalog).toBe(loadCatalog());
    expect(state.catalog.length).toBeGreaterThan(100);
    expect(state.profiles).toBe(profiles);
    expect(state.featureFlags).toStrictEqual({ a: 1 });
    expect(state.effective).toStrictEqual([]);
    expect(EMPTY_KNOBS).toStrictEqual({ effective: [], featureFlags: {} });
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
