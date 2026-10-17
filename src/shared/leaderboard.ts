// The global Reputation leaderboard, shared by the Cloudflare Worker that
// serves it, the extension that uploads to it and the view that shows it.
// An upload carries a display name, three counts, your average tokens a day
// and the ids of the achievements you have unlocked, nothing else.

/** The Cloudflare Worker that serves the board, the default for overlord.leaderboard.url. */
export const LEADERBOARD_URL = 'https://overlord-leaderboard.shane-f34.workers.dev';
/** Anyone with fewer prompts on file is left off the board, since a short history is mostly noise. */
export const MIN_PROMPTS = 100;
/** Rows in each list. */
export const BOARD_SIZE = 10;
/** Uploads one person may make in a UTC day. */
export const UPLOADS_PER_DAY = 5;
export const MAX_NAME_LENGTH = 40;
/**
 * Achievement ids one upload may carry. A number rather than ACHIEVEMENTS.length,
 * since achievements.ts depends on this file through reputation.ts and importing
 * it back would make a cycle. achievements.test.ts keeps the list under it.
 */
export const MAX_ACHIEVEMENTS = 64;
/** A trillion tokens a day is past anything one person runs, so anything above it is junk. */
export const MAX_TOKENS_PER_DAY = 1_000_000_000_000;
/** Shown for anyone who uploads without a name. */
export const ANONYMOUS = 'Anonymous';

/** What an upload sends, and all it sends. An empty name shows as Anonymous. */
export interface ScoreUpload {
  readonly name: string;
  readonly kind: number;
  readonly mean: number;
  readonly prompts: number;
  /** Ids from ACHIEVEMENTS. Missing from builds older than achievements on the board. */
  readonly achievements?: readonly string[];
  /** Average tokens a day over the last 60 days. Missing from builds older than tokens on the board. */
  readonly tokensPerDay?: number;
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
  /** Unlocked achievement ids, in list order. Missing from a server older than achievements on the board. */
  readonly achievements?: readonly string[];
  /** 0 for an upload without it. Missing from a server older than tokens on the board. */
  readonly tokensPerDay?: number;
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

/** Array.isArray narrows unknown to any[], so this keeps the elements unknown. */
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isTokens(value: unknown, max: number): boolean {
  return value === undefined || (isCount(value) && value <= max);
}

function isIdList(value: unknown, max: number): value is readonly string[] {
  return (
    isList(value) &&
    value.length <= max &&
    value.every((id) => typeof id === 'string' && id.length <= MAX_NAME_LENGTH)
  );
}

export function isScoreUpload(value: unknown): value is ScoreUpload {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    value['name'].length <= MAX_NAME_LENGTH &&
    isCount(value['kind']) &&
    isCount(value['mean']) &&
    isCount(value['prompts']) &&
    value['kind'] + value['mean'] <= value['prompts'] &&
    (value['achievements'] === undefined || isIdList(value['achievements'], MAX_ACHIEVEMENTS)) &&
    isTokens(value['tokensPerDay'], MAX_TOKENS_PER_DAY)
  );
}

function isBoardEntry(value: unknown): value is BoardEntry {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['rank'] === 'string' &&
    typeof value['score'] === 'number' &&
    isCount(value['kind']) &&
    isCount(value['mean']) &&
    isCount(value['prompts']) &&
    typeof value['uploadedAt'] === 'number' &&
    (value['achievements'] === undefined || isIdList(value['achievements'], Infinity)) &&
    isTokens(value['tokensPerDay'], Infinity)
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
