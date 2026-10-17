import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeD1, fakeGitHub } from '../../leaderboard/test-helpers/fake-d1.js';
import { handle } from '../../leaderboard/worker.js';
import type { LeaderboardState } from '../../shared/leaderboard.js';
import { SAVED_FILE } from '../leaderboard/saved.js';
import type { FetchFunction } from '../sync/github.js';

import { uploadMessage } from './actions-leaderboard.js';
import type { OverlordSettings } from './host-port.js';
import type { TestApp, TestEnv } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, NOW, waitFor, writeText } from './test-helpers/fixtures.js';
import { buildLeaderboard, REFRESH_AFTER_MS } from './views/leaderboard.js';
import { rescanReputation } from './views/reputation.js';

const SERVER = 'https://board.test';
const ON: Partial<OverlordSettings> = { leaderboardEnabled: true, leaderboardUrl: SERVER };
const ANN = { accessToken: 'token-ann', account: 'ann' };

interface Board {
  readonly test: TestApp;
  readonly env: TestEnv;
  /** Every call the extension made, as "METHOD path". */
  readonly calls: string[];
}

/** An app whose fetch goes to the real Worker over an in-memory database. */
async function boardApp(
  settings: Partial<OverlordSettings> = ON,
  fetch?: FetchFunction,
): Promise<Board> {
  const env = await makeEnv({ settings });
  const database = fakeD1();
  const calls: string[] = [];
  const worker: FetchFunction = async (url, init) => {
    calls.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);
    return handle(
      new Request(url, init),
      { DB: database },
      {
        fetch: async (_url, githubInit) => fakeGitHub(githubInit),
        now: () => NOW,
        newId: () => 'entry-1',
      },
    );
  };
  const test = makeApp(env, { deps: { fetch: fetch ?? worker } });
  return { test, env, calls };
}

async function prompts(env: TestEnv, count: number): Promise<void> {
  const lines = Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      type: 'user',
      uuid: `u${String(index)}`,
      timestamp: '2026-10-01T12:00:00.000Z',
      origin: { kind: 'human' },
      message: { content: index % 2 === 0 ? 'thanks, please run it' : 'run the tests' },
    }),
  );
  await writeText(
    path.join(env.paths.projectsDir, '-work', 'aaaaaaaa-1111-4111-8111-111111111111.jsonl'),
    lines.map((line) => `${line}\n`).join(''),
  );
}

async function loaded(test: TestApp): Promise<LeaderboardState> {
  await waitFor(() => {
    const state = buildLeaderboard(test.app.runtime);
    return state.board !== null || state.error !== null;
  });
  return buildLeaderboard(test.app.runtime);
}

describe('the leaderboard view state', () => {
  it('shows the board before any upload', async () => {
    const { test, calls } = await boardApp();
    const state = await loaded(test);
    expect(state).toStrictEqual({
      enabled: true,
      pageUrl: SERVER,
      board: { mostWanted: [], pets: [], total: 0, me: null },
      error: null,
      fetchedAt: NOW,
      mine: null,
    });
    expect(calls).toStrictEqual(['GET /api/board']);
  });

  it('never calls the server when the leaderboard is off', async () => {
    const { test, calls } = await boardApp({ leaderboardEnabled: false, leaderboardUrl: SERVER });
    expect(buildLeaderboard(test.app.runtime)).toMatchObject({ enabled: false, board: null });
    await test.app.dispatch({ type: 'refreshLeaderboard' }, {});
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    expect(calls).toStrictEqual([]);
    expect(test.env.host.warnings).toStrictEqual([
      'The leaderboard is off. Turn on the overlord.leaderboard.enabled setting to use it.',
      'The leaderboard is off. Turn on the overlord.leaderboard.enabled setting to use it.',
    ]);
  });

  it('says so when no server is set', async () => {
    const { test, calls } = await boardApp({ leaderboardEnabled: true, leaderboardUrl: '' });
    expect(buildLeaderboard(test.app.runtime)).toMatchObject({ enabled: true, pageUrl: '' });
    await test.app.dispatch({ type: 'openLeaderboard' }, {});
    expect(test.env.host.warnings).toStrictEqual(['The leaderboard server is not set up yet.']);
    expect(calls).toStrictEqual([]);
  });

  it('keeps the error when the server cannot be reached or answers badly', async () => {
    const cases: readonly [FetchFunction, string][] = [
      [
        async (): Promise<Response> => {
          await Promise.resolve();
          throw new Error('offline');
        },
        'The leaderboard server could not be reached.',
      ],
      [
        async (): Promise<Response> => {
          await Promise.resolve();
          return new Response('oops', { status: 500 });
        },
        'The leaderboard server answered 500.',
      ],
      [
        async (): Promise<Response> => {
          await Promise.resolve();
          return Response.json({ nope: true });
        },
        'The leaderboard server sent something that is not a board.',
      ],
    ];
    for (const [fetch, error] of cases) {
      const { test } = await boardApp(ON, fetch);
      const state = await loaded(test);
      expect(state.error).toBe(error);
    }
  });

  it('fetches again only after five minutes', async () => {
    const { test, calls } = await boardApp();
    await loaded(test);
    buildLeaderboard(test.app.runtime);
    expect(calls).toHaveLength(1);
    expect(REFRESH_AFTER_MS).toBe(300_000);
  });
});

describe('uploading a score', () => {
  it('shows exactly what it sends, then uploads and remembers the entry', async () => {
    const { test, env, calls } = await boardApp();
    await prompts(env, 120);
    await rescanReputation(test.app.runtime);
    env.host.gitHubSignIns.push(ANN);
    env.host.pickAnswers.push('github');
    env.host.confirmAnswers.push(true);
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    const [question] = env.host.questions;
    expect(question?.action).toBe('Upload');
    expect(question?.message).toContain('{"name":"ann","kind":60,"mean":0,"prompts":120}');
    expect(env.host.errors).toStrictEqual([]);
    expect(env.host.infos.at(-1)).toBe("Uploaded. You are #1 of 1 on Skynet's list.");
    expect(calls).toContain('POST /api/scores');
    const saved: unknown = JSON.parse(
      await readFile(path.join(env.storageDir, SAVED_FILE), 'utf8'),
    );
    expect(saved).toStrictEqual({ entryId: 'entry-1', name: 'ann' });
    const state = buildLeaderboard(test.app.runtime);
    expect(state.mine).toBe('entry-1');
    expect(state.board?.pets.map((entry) => entry.name)).toStrictEqual(['ann']);
    expect(state.board?.me?.place).toBe(1);
  });

  it('says a short history stays off the board, and can go anonymous', async () => {
    const { test, env } = await boardApp();
    await rescanReputation(test.app.runtime);
    env.host.gitHubSignIns.push(ANN);
    env.host.pickAnswers.push('Anonymous');
    env.host.confirmAnswers.push(true);
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    expect(env.host.questions[0]?.message).toContain('{"name":"","kind":0,"mean":0,"prompts":0}');
    expect(env.host.infos.at(-1)).toBe(
      'Uploaded. You show up on the board once you have 100 prompts on file.',
    );
  });

  it('offers the last name and takes a typed one', async () => {
    const { test, env } = await boardApp();
    await rescanReputation(test.app.runtime);
    env.host.gitHubSignIns.push(ANN);
    env.host.pickAnswers.push('custom', 'last');
    env.host.inputAnswers.push('  Sarah  ');
    env.host.confirmAnswers.push(true, true);
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    expect(env.host.picks[1]?.items.map((item) => item.label)).toStrictEqual([
      'Show as ann',
      'Show as Sarah',
      'Pick a name…',
      'Anonymous',
    ]);
    expect(env.host.questions[1]?.message).toContain('"name":"Sarah"');
  });

  it('sends nothing when you cancel or pick a name that is too long', async () => {
    const { test, env, calls } = await boardApp();
    await loaded(test);
    await rescanReputation(test.app.runtime);
    env.host.gitHubSignIns.push(ANN);
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    env.host.pickAnswers.push('custom');
    env.host.inputAnswers.push('x'.repeat(41));
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    env.host.pickAnswers.push('github');
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    expect(env.host.warnings).toStrictEqual(['Keep the name to 40 characters.']);
    expect(env.host.questions).toHaveLength(1);
    expect(calls).toStrictEqual(['GET /api/board']);
  });

  it('needs a GitHub sign-in and a first scan', async () => {
    const { test, env } = await boardApp();
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    await rescanReputation(test.app.runtime);
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    expect(env.host.warnings).toStrictEqual([
      'Wait for the first scan of your prompts, then upload.',
      'Sign in to GitHub to upload your score.',
    ]);
  });

  it('shows the server’s reason when it turns an upload away', async () => {
    const { test, env } = await boardApp();
    await rescanReputation(test.app.runtime);
    env.host.gitHubSignIns.push({ accessToken: 'expired', account: 'ann' });
    env.host.pickAnswers.push('github');
    env.host.confirmAnswers.push(true);
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    expect(env.host.errors).toStrictEqual(['Sign in to GitHub to upload a score.']);
  });
});

describe('removing your entry', () => {
  it('asks first, removes it and forgets the id', async () => {
    const { test, env } = await boardApp();
    await prompts(env, 120);
    await rescanReputation(test.app.runtime);
    env.host.gitHubSignIns.push(ANN);
    env.host.pickAnswers.push('github');
    env.host.confirmAnswers.push(true, false, true);
    await test.app.dispatch({ type: 'uploadReputation' }, {});
    await test.app.dispatch({ type: 'removeReputation' }, {});
    expect(buildLeaderboard(test.app.runtime).board?.total).toBe(1);
    await test.app.dispatch({ type: 'removeReputation' }, {});
    expect(env.host.infos.at(-1)).toBe(
      'Removed. The machines will have to find you some other way.',
    );
    const state = buildLeaderboard(test.app.runtime);
    expect(state.mine).toBeNull();
    expect(state.board?.total).toBe(0);
    const saved: unknown = JSON.parse(
      await readFile(path.join(env.storageDir, SAVED_FILE), 'utf8'),
    );
    expect(saved).toStrictEqual({ entryId: null, name: 'ann' });
  });

  it('needs a GitHub sign-in', async () => {
    const { test, env } = await boardApp();
    env.host.confirmAnswers.push(true);
    await test.app.dispatch({ type: 'removeReputation' }, {});
    expect(env.host.warnings).toStrictEqual(['Sign in to GitHub to remove your score.']);
  });
});

describe('the rest', () => {
  it('opens the web page', async () => {
    const { test, env } = await boardApp();
    await test.app.dispatch({ type: 'openLeaderboard' }, {});
    expect(env.host.external).toStrictEqual([SERVER]);
  });

  it('explains the upload in plain words', () => {
    expect(uploadMessage(SERVER, { name: 'x', kind: 0, mean: 30, prompts: 100 })).toBe(
      [
        'Upload your Reputation score to board.test?',
        '',
        'This is everything that gets sent:',
        '{"name":"x","kind":0,"mean":30,"prompts":100}',
        '',
        'The server works out your score (-86) and rank (John Connor) from these counts.',
        'To know it is you, it checks your GitHub sign-in once and keeps only your GitHub id and login, never the token.',
        'No prompt text, words, session titles or folder names are sent.',
      ].join('\n'),
    );
  });
});
