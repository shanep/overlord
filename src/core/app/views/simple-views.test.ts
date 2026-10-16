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

import { buildFleet, normalizeRateLimits, toFraction, withPlanLimits } from './fleet.js';
import { buildKnobs, EMPTY_KNOBS, loadKnobs, loadProfiles } from './knobs.js';
import { loadUsage } from './usage.js';

function store(bus: EventBus): OverlordStore {
  return new OverlordStore(bus, { scheduler: immediateScheduler });
}

describe('fleet view', () => {
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
    const state = buildFleet(fleetStore, pending, NOW, null);
    expect(state.sessions.map((item) => item.id)).toStrictEqual(['s1']);
    expect(state.pendingPermissions).toBe(pending);
    expect(state.rateLimits).toStrictEqual({ fiveHourPct: 0.8, sevenDayPct: null, resetsAt: null });
    expect(state.spendPerHourUsd).toBe(0);
    expect(state.agents).toStrictEqual([]);
    expect(sorted(Object.keys(state))).toStrictEqual([
      'agents',
      'pendingPermissions',
      'rateLimits',
      'sessions',
      'spendPerHourUsd',
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
    expect(buildFleet(fleetStore, [], NOW, plan).rateLimits).toStrictEqual({
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
