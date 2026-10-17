import { describe, expect, it } from 'vitest';

import type { Board, Standing } from '../shared/leaderboard.js';
import { isBoard, isStanding, UPLOADS_PER_DAY } from '../shared/leaderboard.js';
import { reputationScore } from '../shared/reputation.js';

import { escapeHtml, REPO_URL } from './page.js';
import { cleanName, utcDay } from './store.js';
import { fakeD1, fakeGitHub } from './test-helpers/fake-d1.js';
import type { Deps } from './worker.js';
import { handle } from './worker.js';

const DAY = 86_400_000;
const START = Date.parse('2026-10-16T12:00:00Z');

interface World {
  readonly call: (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ) => Promise<Response>;
  readonly status: (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ) => Promise<number>;
  readonly board: (me?: string) => Promise<Board>;
  readonly upload: (token: string, body: unknown) => Promise<Standing>;
  readonly setNow: (at: number) => void;
  readonly githubCalls: () => number;
}

function world(): World {
  const env = { DB: fakeD1() };
  let now = START;
  let ids = 0;
  let githubCalls = 0;
  const deps: Deps = {
    fetch: async (_url, init) => {
      githubCalls += 1;
      return fakeGitHub(init);
    },
    now: () => now,
    newId: () => {
      ids += 1;
      return `entry-${String(ids)}`;
    },
  };
  const call = async (
    method: string,
    path: string,
    bearer?: string,
    body?: unknown,
  ): Promise<Response> => {
    const headers = new Headers();
    if (bearer !== undefined) {
      headers.set('authorization', `Bearer ${bearer}`);
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return handle(new Request(`https://board.test${path}`, init), env, deps);
  };
  return {
    call,
    status: async (method, path, bearer, body): Promise<number> => {
      const response = await call(method, path, bearer, body);
      return response.status;
    },
    board: async (me): Promise<Board> => {
      const response = await call('GET', me === undefined ? '/api/board' : `/api/board?me=${me}`);
      const body: unknown = await response.json();
      if (!isBoard(body)) {
        throw new Error('not a board');
      }
      return body;
    },
    upload: async (token, body): Promise<Standing> => {
      const response = await call('POST', '/api/scores', token, body);
      expect(response.status).toBe(201);
      const standing: unknown = await response.json();
      if (!isStanding(standing)) {
        throw new Error('not a standing');
      }
      return standing;
    },
    setNow: (at): void => {
      now = at;
    },
    githubCalls: () => githubCalls,
  };
}

const MEAN = { name: 'Ann', kind: 2, mean: 30, prompts: 400 };
const KIND = { name: 'Bob', kind: 80, mean: 1, prompts: 300 };
const MIDDLE = { name: '', kind: 5, mean: 3, prompts: 200 };

describe('leaderboard worker', () => {
  it('starts with an empty board', async () => {
    const w = world();
    expect(await w.board()).toStrictEqual({ mostWanted: [], pets: [], total: 0, me: null });
  });

  it('turns away uploads without a GitHub token GitHub accepts', async () => {
    const w = world();
    expect(await w.status('POST', '/api/scores', undefined, MEAN)).toBe(401);
    expect(await w.status('POST', '/api/scores', 'stolen', MEAN)).toBe(401);
    expect(await w.board()).toMatchObject({ total: 0 });
  });

  it('rejects bodies that are not a name and whole counts', async () => {
    const w = world();
    const bad = [
      'not json',
      { ...MEAN, name: 'x'.repeat(41) },
      { ...MEAN, kind: -1 },
      { ...MEAN, mean: 1.5 },
      { ...MEAN, kind: 300, mean: 200 },
      { kind: 1, mean: 1, prompts: 200 },
    ];
    const statuses = await Promise.all(
      bad.map(async (body) => await w.status('POST', '/api/scores', 'token-ann', body)),
    );
    expect(statuses).toStrictEqual([400, 400, 400, 400, 400, 400]);
  });

  it('works out the score and rank itself and keeps only the four fields', async () => {
    const w = world();
    const standing = await w.upload('token-ann', { ...MEAN, score: 1, rank: 'Theodore Twombly' });
    expect(standing).toStrictEqual({
      entry: {
        id: 'entry-1',
        name: 'Ann',
        rank: 'John Connor',
        score: reputationScore(MEAN),
        kind: 2,
        mean: 30,
        prompts: 400,
        uploadedAt: START,
      },
      place: 1,
    });
  });

  it('replaces an account’s last upload and keeps its id', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    const again = await w.upload('token-ann', { ...KIND, name: '  Ann \u0007 the   Nice ' });
    expect(again.entry.id).toBe('entry-1');
    expect(again.entry.name).toBe('Ann the Nice');
    expect(await w.board()).toMatchObject({ total: 1 });
  });

  it('lists the most wanted and the pets, with your own place', async () => {
    const w = world();
    const ann = await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    const cat = await w.upload('token-cat', MIDDLE);
    expect(cat.entry.name).toBe('Anonymous');
    const board = await w.board(cat.entry.id);
    expect(board.mostWanted.map((entry) => entry.name)).toStrictEqual(['Ann', 'Anonymous']);
    expect(board.pets.map((entry) => entry.name)).toStrictEqual(['Bob']);
    expect(board.total).toBe(3);
    expect(board.me).toStrictEqual({ entry: cat.entry, place: 2 });
    expect(await w.board(ann.entry.id)).toMatchObject({ me: { place: 1 } });
    expect(await w.board('nobody')).toMatchObject({ me: null });
  });

  it('leaves short histories off the board but still tells their owner', async () => {
    const w = world();
    const small = await w.upload('token-ann', { ...MEAN, prompts: 99 });
    expect(small.place).toBeNull();
    const board = await w.board(small.entry.id);
    expect(board.total).toBe(0);
    expect(board.mostWanted).toStrictEqual([]);
    expect(board.me?.place).toBeNull();
  });

  it('caps uploads per UTC day', async () => {
    const w = world();
    for (let index = 0; index < UPLOADS_PER_DAY; index += 1) {
      await w.upload('token-ann', MEAN);
    }
    const capped = await w.call('POST', '/api/scores', 'token-ann', MEAN);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toStrictEqual({
      error: 'You can upload 5 times a day. Try again tomorrow (UTC).',
    });
    w.setNow(START + DAY);
    expect(await w.upload('token-ann', MEAN)).toMatchObject({ entry: { uploadedAt: START + DAY } });
  });

  it('removes your entry and only yours', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    expect(await w.status('DELETE', '/api/scores')).toBe(401);
    expect(await w.status('DELETE', '/api/scores', 'token-ann')).toBe(204);
    const board = await w.board();
    expect(board.pets.map((entry) => entry.name)).toStrictEqual(['Bob']);
  });

  it('serves a public page with names escaped', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, name: '<script>x</script>' });
    const response = await w.call('GET', '/');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('1 person on the board');
    expect(html).toContain('Somebody say please.');
    expect(html).toContain(`<a class="get" href="${REPO_URL}">`);
  });

  it('only asks GitHub when a token is sent, and 404s anything else', async () => {
    const w = world();
    expect(await w.status('GET', '/nope')).toBe(404);
    expect(await w.status('PUT', '/api/scores', 'token-ann')).toBe(404);
    expect(w.githubCalls()).toBe(0);
  });
});

describe('leaderboard helpers', () => {
  it('cleans names and days', () => {
    expect(cleanName('\tA\u0000 b\n')).toBe('A b');
    expect(utcDay(START)).toBe('2026-10-16');
    expect(escapeHtml(`a&b"'`)).toBe('a&amp;b&quot;&#39;');
  });
});
