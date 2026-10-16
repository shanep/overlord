import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FrustrationState } from '../../../shared/protocol.js';
import type { TestApp, TestEnv } from '../test-helpers/fixtures.js';
import { makeApp, makeEnv, NOW, session, waitFor, writeText } from '../test-helpers/fixtures.js';

import {
  buildFrustration,
  EMPTY_FRUSTRATION,
  FRUSTRATION_FILE,
  RESCAN_AFTER_MS,
  rescanFrustration,
} from './frustration.js';

const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const S3 = 'cccccccc-3333-4333-8333-333333333333';

function prompt(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-10-01T12:00:00.000Z',
    origin: { kind: 'human' },
    message: { content: text },
  });
}

async function transcript(
  env: TestEnv,
  sessionId: string,
  lines: readonly string[],
): Promise<void> {
  await writeText(
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

/** Waits until the check passes and the scan that got there has finished writing. */
async function settled(
  test: TestApp,
  check: (state: FrustrationState) => boolean,
): Promise<FrustrationState> {
  await waitFor((): boolean => check(buildFrustration(test.app.runtime)));
  return rescanFrustration(test.app.runtime);
}

describe('buildFrustration', () => {
  it('starts empty, scans in the background, saves the index and notifies', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [prompt('u1', 'you idiot'), prompt('u2', 'fine')]);
    const { test, notified } = clockedApp(env);
    expect(buildFrustration(test.app.runtime)).toBe(EMPTY_FRUSTRATION);
    const state = await settled(test, (next) => next.scannedAt !== null);
    expect(state).toMatchObject({ totalPrompts: 2, atClaude: 1, general: 0, scannedAt: NOW });
    expect(state.bySession).toStrictEqual([
      { sessionId: S1, title: 'Session aaaaaaaa', prompts: 2, hits: 1 },
    ]);
    expect(notified()).toBeGreaterThanOrEqual(2);
    const saved: unknown = JSON.parse(
      await readFile(path.join(env.storageDir, FRUSTRATION_FILE), 'utf8'),
    );
    expect(saved).toMatchObject({ version: 1, scannedAt: NOW });
  });

  it('writes nothing for an empty home', async () => {
    const env = await makeEnv();
    const { test } = clockedApp(env);
    const state = await settled(test, (next) => next.scannedAt !== null);
    expect(state.totalPrompts).toBe(0);
    await expect(readFile(path.join(env.storageDir, FRUSTRATION_FILE), 'utf8')).rejects.toThrow(
      'ENOENT',
    );
    expect(test.app.errorList()).toStrictEqual([]);
  });

  it('saves when a transcript is gone, and keeps its counts', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [prompt('u1', 'shit')]);
    const { test } = clockedApp(env);
    await settled(test, (next) => next.totalPrompts === 1);
    await rm(path.join(env.paths.projectsDir, '-work', `${S1}.jsonl`));
    const state = await rescanFrustration(test.app.runtime);
    expect(state.totalPrompts).toBe(1);
    const saved: unknown = JSON.parse(
      await readFile(path.join(env.storageDir, FRUSTRATION_FILE), 'utf8'),
    );
    expect(saved).toHaveProperty('files', {});
    expect(saved).toMatchObject({ prompts: { 't:u1': { sessionId: S1 } } });
  });

  it('rescans only after a minute', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [prompt('u1', 'shit')]);
    const { test, advance } = clockedApp(env);
    await settled(test, (next) => next.totalPrompts === 1);
    await transcript(env, S1, [prompt('u1', 'shit'), prompt('u2', 'damn')]);
    advance(RESCAN_AFTER_MS - 1);
    buildFrustration(test.app.runtime);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(buildFrustration(test.app.runtime).totalPrompts).toBe(1);
    advance(1);
    const state = await settled(test, (next) => next.totalPrompts === 2);
    expect(state.general).toBe(2);
  });

  it('names sessions from the store, then the transcript, then the id', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [prompt('u1', 'shit')]);
    await transcript(env, S2, [
      prompt('u2', 'shit'),
      JSON.stringify({ type: 'custom-title', customTitle: 'Peeked title' }),
    ]);
    await transcript(env, S3, [prompt('u3', 'shit')]);
    const { test } = clockedApp(env);
    test.bus.emit('session.upserted', session(S1, { title: 'Live title' }));
    const state = await settled(test, (next) => next.bySession.length === 3);
    const titles = Object.fromEntries(state.bySession.map((row) => [row.sessionId, row.title]));
    expect(titles).toStrictEqual({
      [S1]: 'Live title',
      [S2]: 'Peeked title',
      [S3]: 'Session cccccccc',
    });
  });

  it('keeps saved counts after the transcripts are gone', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [prompt('u1', 'shit')]);
    const first = clockedApp(env);
    await settled(first.test, (next) => next.totalPrompts === 1);
    const later = await makeEnv();
    await writeText(
      path.join(later.storageDir, FRUSTRATION_FILE),
      await readFile(path.join(env.storageDir, FRUSTRATION_FILE), 'utf8'),
    );
    const second = clockedApp(later);
    const state = await settled(second.test, (next) => next.totalPrompts === 1);
    expect(state.general).toBe(1);
  });

  it('reports and rewrites a corrupt index, and reports an unreadable one', async () => {
    const env = await makeEnv();
    await writeText(path.join(env.storageDir, FRUSTRATION_FILE), '{broken');
    const { test, advance } = clockedApp(env);
    await settled(test, (next) => next.scannedAt !== null);
    expect(test.app.errorList().map((error) => error.message)).toStrictEqual([
      `The frustration index could not be read. It was copied to ${path.join(env.storageDir, FRUSTRATION_FILE)}.corrupt-${String(NOW)} and rebuilt.`,
    ]);
    const rewritten: unknown = JSON.parse(
      await readFile(path.join(env.storageDir, FRUSTRATION_FILE), 'utf8'),
    );
    expect(rewritten).toMatchObject({ version: 1, prompts: {} });
    // The index stays in memory, so a later rescan does not read the file again.
    await writeText(path.join(env.storageDir, FRUSTRATION_FILE), '{broken');
    advance(1);
    await rescanFrustration(test.app.runtime);
    expect(test.app.errorList()).toHaveLength(1);
    const blocked = await makeEnv();
    await writeFile(blocked.storageDir, 'a file where the folder should be');
    const broken = clockedApp(blocked);
    buildFrustration(broken.test.app.runtime);
    await waitFor(() => broken.test.app.errorList().length > 0);
    expect(broken.test.app.errorList()[0]?.source).toBe('frustration');
  });
});

describe('rescanFrustration', () => {
  it('waits for a running scan instead of starting a second one', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [prompt('u1', 'shit')]);
    const { test } = clockedApp(env);
    buildFrustration(test.app.runtime);
    const [left, right] = await Promise.all([
      rescanFrustration(test.app.runtime),
      rescanFrustration(test.app.runtime),
    ]);
    expect(left).toStrictEqual(right);
    expect(left.totalPrompts).toBe(1);
  });

  it('shows the totals after the action', async () => {
    const env = await makeEnv();
    await transcript(env, S1, [prompt('u1', 'you idiot'), prompt('u2', 'this is shit')]);
    const { test } = clockedApp(env);
    await test.app.dispatch({ type: 'rescanFrustration' }, {});
    await transcript(env, S2, [prompt('u3', 'fine')]);
    await test.app.dispatch({ type: 'rescanFrustration' }, {});
    expect(env.host.infos).toStrictEqual([
      'Frustration rescan done: 2 prompts, 2 hits (1 aimed at Claude, 1 general).',
      'Frustration rescan done: 3 prompts, 2 hits (1 aimed at Claude, 1 general).',
    ]);
    const single = await makeEnv();
    await transcript(single, S1, [prompt('u1', 'damn')]);
    const one = clockedApp(single);
    await one.test.app.dispatch({ type: 'rescanFrustration' }, {});
    expect(single.host.infos).toStrictEqual([
      'Frustration rescan done: 1 prompt, 1 hit (0 aimed at Claude, 1 general).',
    ]);
  });
});
