// The global Reputation leaderboard, shared by the Cloudflare Worker that
// serves it, the extension that uploads to it and the view that shows it.
// An upload carries a display name and three counts, nothing else.

/** The Cloudflare Worker that serves the board, the default for overlord.leaderboard.url. */
export const LEADERBOARD_URL = 'https://overlord-leaderboard.shane-f34.workers.dev';
/** Anyone with fewer prompts on file is left off the board, since a short history is mostly noise. */
export const MIN_PROMPTS = 100;
/** Rows in each list. */
export const BOARD_SIZE = 10;
/** Uploads one person may make in a UTC day. */
export const UPLOADS_PER_DAY = 5;
export const MAX_NAME_LENGTH = 40;
/** Shown for anyone who uploads without a name. */
export const ANONYMOUS = 'Anonymous';

/** What an upload sends, and all it sends. An empty name shows as Anonymous. */
export interface ScoreUpload {
  readonly name: string;
  readonly kind: number;
  readonly mean: number;
  readonly prompts: number;
}

/** One person on the board. The id is random, not their GitHub id. */
export interface BoardEntry {
  readonly id: string;
  readonly name: string;
  readonly rank: string;
  readonly score: number;
  readonly kind: number;
  readonly mean: number;
  readonly prompts: number;
  readonly uploadedAt: number;
}

/** Where one entry stands. Place is counted from the most wanted, and is null below MIN_PROMPTS. */
export interface Standing {
  readonly entry: BoardEntry;
  readonly place: number | null;
}

export interface Board {
  /** The scores below 0, the most wanted first. */
  readonly mostWanted: readonly BoardEntry[];
  /** The scores above 0, the most loved first. */
  readonly pets: readonly BoardEntry[];
  /** Everyone with at least MIN_PROMPTS. */
  readonly total: number;
  /** The caller's own entry, when the request named one. */
  readonly me: Standing | null;
}

/** The global leaderboard as the Reputation view shows it. */
export interface LeaderboardState {
  /** False when the overlord.leaderboard.enabled setting is off. The view never calls the server then. */
  readonly enabled: boolean;
  /** The public page, or empty when no server is set. */
  readonly pageUrl: string;
  /** Null before the first fetch, or when it failed. */
  readonly board: Board | null;
  readonly error: string | null;
  readonly fetchedAt: number | null;
  /** Your entry's id once you have uploaded, so your row can be picked out. */
  readonly mine: string | null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isScoreUpload(value: unknown): value is ScoreUpload {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    value['name'].length <= MAX_NAME_LENGTH &&
    isCount(value['kind']) &&
    isCount(value['mean']) &&
    isCount(value['prompts']) &&
    value['kind'] + value['mean'] <= value['prompts']
  );
}

export function isBoardEntry(value: unknown): value is BoardEntry {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['rank'] === 'string' &&
    typeof value['score'] === 'number' &&
    isCount(value['kind']) &&
    isCount(value['mean']) &&
    isCount(value['prompts']) &&
    typeof value['uploadedAt'] === 'number'
  );
}

export function isStanding(value: unknown): value is Standing {
  return (
    isRecord(value) &&
    isBoardEntry(value['entry']) &&
    (value['place'] === null || isCount(value['place']))
  );
}

export function isBoard(value: unknown): value is Board {
  return (
    isRecord(value) &&
    Array.isArray(value['mostWanted']) &&
    value['mostWanted'].every(isBoardEntry) &&
    Array.isArray(value['pets']) &&
    value['pets'].every(isBoardEntry) &&
    isCount(value['total']) &&
    (value['me'] === null || isStanding(value['me']))
  );
}
