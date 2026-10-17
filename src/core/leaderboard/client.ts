// Calls to the leaderboard server. Reading the board sends only your entry id
// (when you have one). Uploading and removing send your GitHub token, which
// the server checks once with GitHub and drops.

import type { Board, ScoreUpload, Standing } from '../../shared/leaderboard.js';
import { isBoard, isStanding } from '../../shared/leaderboard.js';
import type { FetchFunction } from '../sync/github.js';

const TIMEOUT_MS = 10_000;

class LeaderboardError extends Error {
  override readonly name = 'LeaderboardError';
}

function endpoint(base: string, route: string, query?: Readonly<Record<string, string>>): string {
  const url = new URL(route, base.endsWith('/') ? base : `${base}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** The server's own words for a failed call, or the status when it gave none. */
async function failure(response: Response): Promise<LeaderboardError> {
  try {
    const body: unknown = await response.json();
    const error: unknown =
      typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined;
    if (typeof error === 'string') {
      return new LeaderboardError(error);
    }
  } catch {
    // Not JSON, so fall back to the status.
  }
  return new LeaderboardError(`The leaderboard server answered ${String(response.status)}.`);
}

async function call(fetch: FetchFunction, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new LeaderboardError('The leaderboard server could not be reached.');
  }
}

export async function fetchBoard(
  fetch: FetchFunction,
  base: string,
  me: string | null,
): Promise<Board> {
  const response = await call(
    fetch,
    endpoint(base, 'api/board', me === null ? undefined : { me }),
    { method: 'GET' },
  );
  if (!response.ok) {
    throw await failure(response);
  }
  const body: unknown = await response.json();
  if (!isBoard(body)) {
    throw new LeaderboardError('The leaderboard server sent something that is not a board.');
  }
  return body;
}

export async function uploadScore(
  fetch: FetchFunction,
  base: string,
  token: string,
  upload: ScoreUpload,
): Promise<Standing> {
  const response = await call(fetch, endpoint(base, 'api/scores'), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(upload),
  });
  if (!response.ok) {
    throw await failure(response);
  }
  const body: unknown = await response.json();
  if (!isStanding(body)) {
    throw new LeaderboardError('The leaderboard server sent back something unexpected.');
  }
  return body;
}

export async function removeEntry(
  fetch: FetchFunction,
  base: string,
  token: string,
): Promise<void> {
  const response = await call(fetch, endpoint(base, 'api/scores'), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw await failure(response);
  }
}
