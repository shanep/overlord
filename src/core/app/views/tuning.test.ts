import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TuningState } from '../../../shared/tuning.js';
import type { TestApp, TestEnv } from '../test-helpers/fixtures.js';
import { makeApp, makeEnv, NOW, waitFor, writeText } from '../test-helpers/fixtures.js';

import {
  buildTuning,
  EMPTY_TUNING,
  RESCAN_AFTER_MS,
  rescanTuning,
  TUNING_FILE,
  TRACKED_FILE,
} from './tuning.js';

const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';

function request(id: string, cacheRead: number): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${id}`,
    timestamp: '2026-10-01T12:00:00.000Z',
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 0,
        output_tokens: 1000,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
      },
      content: [],
    },
  });
}

async function transcript(
  env: TestEnv,
  sessionId: string,
  lines: readonly string[],
): Promise<string> {
  return writeText(
    path.join(env.paths.projectsDir, '-work', `${sessionId}.jsonl`),
    lines.map((line) => `${line}\n`).join(''),
  );
}

interface Clocked {
  readonly test: TestApp;
  readonly advance: (ms: number) => void;
  readonly notified: () => number;
}

function clockedApp(env: TestEnv): Clocked {
  let now = NOW;
  const test = makeApp(env, { deps: { clock: () => now } });
  let count = 0;
  test.app.onChange(() => {
    count += 1;
  });
  return {
    test,
    advance: (ms): void => {
      now += ms;
    },
    notified: (): number => count,
  };
}

function trackedSince(state: TuningState): number | undefined {
  return state.tips.find((tip) => tip.id === 'huge-context')?.impact?.trackedSince;
}

/** Waits until the check passes and the scan that got there has finished writing. */
async function settled(
  test: TestApp,
  check: (state: TuningState) => boolean,
): Promise<TuningState> {
  await waitFor((): boolean => check(buildTuning(test.app.runtime)));
  return rescanTuning(test.app.runtime);
}

describe('buildTuning', () => {
  it('starts empty, scans in the background, saves the index and notifies', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [request('m1', 300_000), request('m2', 300_000)]);
    const { test, notified } = clockedApp(env);
    expect(buildTuning(test.app.runtime)).toBe(EMPTY_TUNING);
    const state = await settled(test, (next) => next.scannedAt !== null);
    expect(state).toMatchObject({ sessions: 1, largestContext: 300_000, scannedAt: NOW });
    expect(state.tips.map((tip) => tip.id)).toStrictEqual(['huge-context']);
    expect(state.rows.map((row) => row.sessionId)).toStrictEqual([S1]);
    expect(notified()).toBeGreaterThanOrEqual(2);
    const saved: unknown = JSON.parse(
      await readFile(path.join(env.storageDir, TUNING_FILE), 'utf8'),
    );
    expect(saved).toMatchObject({ version: 4, scannedAt: NOW });
  });

  it('writes nothing for an empty home', async () => {
    const env = await makeEnv();
    const { test } = clockedApp(env);
    const state = await settled(test, (next) => next.scannedAt !== null);
    expect(state.sessions).toBe(0);
    await expect(readFile(path.join(env.storageDir, TUNING_FILE), 'utf8')).rejects.toThrow(
      'ENOENT',
    );
    expect(test.app.errorList()).toStrictEqual([]);
  });

  it('loads the saved index in a new app, and keeps a deleted transcript as history', async () => {
    const env = await makeEnv();
    const file = await transcript(env, S1, [request('m1', 10)]);
    await settled(clockedApp(env).test, (next) => next.sessions === 1);
    const { test } = clockedApp(env);
    await rm(file);
    const state = await rescanTuning(test.app.runtime);
    expect(state.sessions).toBe(0);
    const saved = JSON.parse(await readFile(path.join(env.storageDir, TUNING_FILE), 'utf8')) as {
      entries: Record<string, { live: boolean }>;
    };
    expect(Object.values(saved.entries).map((entry) => entry.live)).toStrictEqual([false]);
  });

  it('rescans only after a minute', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [request('m1', 10)]);
    const { test, advance } = clockedApp(env);
    await settled(test, (next) => next.sessions === 1);
    await transcript(env, 'bbbbbbbb-2222-4222-8222-222222222222', [request('m2', 10)]);
    advance(RESCAN_AFTER_MS - 1);
    buildTuning(test.app.runtime);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(buildTuning(test.app.runtime).sessions).toBe(1);
    advance(1);
    await settled(test, (next) => next.sessions === 2);
  });

  it('reports a failed scan', async () => {
    const env = await makeEnv();
    // A folder where the index file should go makes the save fail.
    await transcript(env, S1, [request('m1', 10)]);
    await mkdir(path.join(env.storageDir, TUNING_FILE), { recursive: true });
    const { test } = clockedApp(env);
    buildTuning(test.app.runtime);
    await waitFor(() => test.app.errorList().some((error) => error.source === 'tuning'));
    expect(test.app.errorList().find((error) => error.source === 'tuning')?.message).toMatch(
      /EISDIR/u,
    );
  });
});

describe('tips actions', () => {
  it('rescans and says what it found', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [request('m1', 10)]);
    const { app } = makeApp(env);
    await app.dispatch({ type: 'rescanTuning' }, {});
    expect(env.host.infos).toStrictEqual(['Tuning rescan done: 1 session, 0 tips.']);
  });

  it('refuses an unknown suggestion', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'createSuggestion', suggestionId: 'nope' }, {});
    expect(env.host.errors).toStrictEqual(['There is no suggestion called nope.']);
  });

  it('creates a suggested skill and agent and marks them installed', async () => {
    const env = await makeEnv({ workspace: true });
    const workspace = env.host.workspace ?? '';
    const { app } = makeApp(env);
    await rescanTuning(app.runtime);
    env.host.pickAnswers.push('user', 'project');
    await app.dispatch({ type: 'createSuggestion', suggestionId: 'land' }, {});
    await app.dispatch({ type: 'createSuggestion', suggestionId: 'scout' }, {});
    const skill = path.join(env.paths.userSkillsDir, 'land', 'SKILL.md');
    const agent = path.join(workspace, '.claude', 'agents', 'scout.md');
    expect(await readFile(skill, 'utf8')).toMatch(/^---\nname: land\n/u);
    expect(await readFile(agent, 'utf8')).toMatch(/^---\nname: scout\n/u);
    expect(env.host.opened).toStrictEqual([skill, agent]);
    const installed = buildTuning(app.runtime)
      .suggestions.filter((item) => item.installed)
      .map((item) => item.id);
    expect(installed.toSorted((left, right) => left.localeCompare(right))).toStrictEqual([
      'land',
      'scout',
    ]);
  });

  it('leaves things alone when the save is cancelled', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'createSuggestion', suggestionId: 'handoff' }, {});
    expect(env.host.opened).toStrictEqual([]);
  });

  it('tracks a tip from now, keeps it in a new app, and stops', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [request('m1', 300_000)]);
    const { test } = clockedApp(env);
    await rescanTuning(test.app.runtime);
    await test.app.dispatch({ type: 'trackTip', tipId: 'huge-context', on: true }, {});
    expect(trackedSince(buildTuning(test.app.runtime))).toBe(NOW);
    const saved: unknown = JSON.parse(
      await readFile(path.join(env.storageDir, TRACKED_FILE), 'utf8'),
    );
    expect(saved).toStrictEqual({ version: 1, tips: { 'huge-context': { since: NOW } } });
    const again = clockedApp(env).test;
    expect(trackedSince(await rescanTuning(again.app.runtime))).toBe(NOW);
    await again.app.dispatch({ type: 'trackTip', tipId: 'huge-context', on: false }, {});
    expect(trackedSince(buildTuning(again.app.runtime))).toBeUndefined();
  });

  it('refuses to track an unknown tip', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'trackTip', tipId: 'nope', on: true }, {});
    expect(env.host.errors).toStrictEqual(['There is no tip called nope.']);
  });

  it('starts tracking a shown tip when its knob is set from Overlord', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [request('m1', 300_000)]);
    const { test, advance } = clockedApp(env);
    await rescanTuning(test.app.runtime);
    const knob = async (value: unknown): Promise<void> => {
      await test.app.dispatch(
        { type: 'setKnob', key: 'autoCompactWindow', value, layer: 'user' },
        {},
      );
    };
    // Clearing a knob is not taking the advice.
    await knob(null);
    expect(buildTuning(test.app.runtime).tips.map((tip) => tip.impact)).toStrictEqual([null]);
    await knob(300_000);
    advance(1000);
    // Setting it again keeps the first start.
    await knob(250_000);
    const [tip] = buildTuning(test.app.runtime).tips;
    expect(tip?.impact?.trackedSince).toBe(NOW);
  });

  it('starts tracking the tips a created suggestion helps with', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [request('m1', 300_000)]);
    const { test } = clockedApp(env);
    await rescanTuning(test.app.runtime);
    env.host.pickAnswers.push('user');
    // The scout agent does not help with huge contexts, so nothing starts.
    await test.app.dispatch({ type: 'createSuggestion', suggestionId: 'scout' }, {});
    expect(buildTuning(test.app.runtime).tips[0]?.impact).toBeNull();
    env.host.pickAnswers.push('user');
    await test.app.dispatch({ type: 'createSuggestion', suggestionId: 'handoff' }, {});
    expect(buildTuning(test.app.runtime).tips[0]?.impact?.trackedSince).toBe(NOW);
  });
});
