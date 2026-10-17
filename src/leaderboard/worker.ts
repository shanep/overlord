// The Cloudflare Worker behind the Reputation leaderboard. It serves the
// public page at /, the board as JSON at /api/board, and takes uploads and
// removals at /api/scores. A GitHub token proves who is uploading: it is
// checked once with GitHub and then dropped, never stored or logged.

import { isScoreUpload, UPLOADS_PER_DAY } from '../shared/leaderboard.js';

import { renderPage } from './page.js';
import type { Account, D1Database } from './store.js';
import { readBoard, removeScore, saveScore } from './store.js';

export interface Env {
  readonly DB: D1Database;
}

/** What the handler needs from the outside, so tests can stand in for GitHub and the clock. */
export interface Deps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly newId: () => string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return Response.json(body, {
    status,
    headers: { ...JSON_HEADERS, 'cache-control': cache },
  });
}

function fail(status: number, error: string): Response {
  return json({ error }, status);
}

/** The id and login from GitHub's user response, the only fields kept. */
function accountFrom(user: unknown): Account | null {
  if (typeof user !== 'object' || user === null) {
    return null;
  }
  const id: unknown = Reflect.get(user, 'id');
  const login: unknown = Reflect.get(user, 'login');
  return typeof id === 'number' && typeof login === 'string' ? { githubId: id, login } : null;
}

/** The GitHub account behind a bearer token, or null when GitHub does not accept it. */
async function accountOf(request: Request, deps: Deps): Promise<Account | null> {
  const match = /^Bearer (\S+)$/u.exec(request.headers.get('authorization') ?? '');
  const bearer = match?.[1];
  if (bearer === undefined) {
    return null;
  }
  const response = await deps.fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'overlord-leaderboard',
    },
  });
  if (!response.ok) {
    return null;
  }
  return accountFrom(await response.json());
}

async function upload(request: Request, env: Env, deps: Deps): Promise<Response> {
  const account = await accountOf(request, deps);
  if (account === null) {
    return fail(401, 'Sign in to GitHub to upload a score.');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'The upload is not JSON.');
  }
  if (!isScoreUpload(body)) {
    return fail(400, 'The upload needs a short name and whole, non-negative counts.');
  }
  // Only the four fields are kept, whatever else the body holds.
  const { name, kind, mean, prompts } = body;
  const saved = await saveScore(env.DB, {
    account,
    upload: { name, kind, mean, prompts },
    now: deps.now(),
    newId: deps.newId,
  });
  if (!saved.ok) {
    return fail(
      429,
      `You can upload ${String(UPLOADS_PER_DAY)} times a day. Try again tomorrow (UTC).`,
    );
  }
  return json(saved.standing, 201);
}

async function remove(request: Request, env: Env, deps: Deps): Promise<Response> {
  const account = await accountOf(request, deps);
  if (account === null) {
    return fail(401, 'Sign in to GitHub to remove your score.');
  }
  await removeScore(env.DB, account);
  return new Response(null, { status: 204 });
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case 'GET /': {
      const board = await readBoard(env.DB, null);
      return new Response(renderPage(board, deps.now()), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=60',
        },
      });
    }
    case 'GET /api/board': {
      const me = url.searchParams.get('me');
      const board = await readBoard(env.DB, me === '' ? null : me);
      return json(board, 200, me === null ? 'public, max-age=60' : 'no-store');
    }
    case 'POST /api/scores': {
      return upload(request, env, deps);
    }
    case 'DELETE /api/scores': {
      return remove(request, env, deps);
    }
    default: {
      return fail(404, 'Nothing here.');
    }
  }
}

const live: Deps = {
  fetch: async (url, init) => fetch(url, init),
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
};

// Cloudflare runs a module Worker from its default export.
// eslint-disable-next-line import-x/no-default-export -- the Workers runtime needs it
export default {
  fetch: async (request: Request, env: Env): Promise<Response> => handle(request, env, live),
};
