// The leaderboard's one table in Cloudflare D1: a row per GitHub account. The
// D1 types here are the few calls this file makes, so the Worker needs no
// Cloudflare type package.

import { knownIds } from '../shared/achievements.js';
import type { Board, BoardEntry, ScoreUpload, Standing } from '../shared/leaderboard.js';
import { ANONYMOUS, BOARD_SIZE, MIN_PROMPTS, UPLOADS_PER_DAY } from '../shared/leaderboard.js';
import { rankFor } from '../shared/reputation-ranks.js';
import { reputationScore } from '../shared/reputation.js';

export type Row = Readonly<Record<string, unknown>>;

export interface D1Statement {
  bind: (...values: readonly (string | number)[]) => D1Statement;
  first: () => Promise<Row | null>;
  all: () => Promise<{ readonly results: readonly Row[] }>;
  run: () => Promise<unknown>;
}

export interface D1Database {
  prepare: (query: string) => D1Statement;
}

/** Who the GitHub token belongs to. Only these two fields are kept. */
export interface Account {
  readonly githubId: number;
  readonly login: string;
}

const COLUMNS =
  'entry_id, name, kind, mean, prompts, score, uploaded_at, achievements, tokens_per_day';
const LISTED = `prompts >= ${String(MIN_PROMPTS)}`;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new TypeError(`column ${key} is not text`);
  }
  return value;
}

function number_(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') {
    throw new TypeError(`column ${key} is not a number`);
  }
  return value;
}

function entryOf(row: Row): BoardEntry {
  const name = text(row, 'name');
  const score = number_(row, 'score');
  return {
    id: text(row, 'entry_id'),
    name: name === '' ? ANONYMOUS : name,
    rank: rankFor(score).name,
    score,
    kind: number_(row, 'kind'),
    mean: number_(row, 'mean'),
    prompts: number_(row, 'prompts'),
    uploadedAt: number_(row, 'uploaded_at'),
    // Dropping unknown ids means a retired achievement just stops showing.
    achievements: knownIds(text(row, 'achievements').split(',')),
    tokensPerDay: number_(row, 'tokens_per_day'),
  };
}

/** UTC calendar date, YYYY-MM-DD, which is when the upload cap resets. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Trims the name, drops control characters and squeezes runs of spaces. */
export function cleanName(name: string): string {
  return name
    .replaceAll(/\p{Cc}/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

/** The most wanted have scores below 0 and the pets above it, so nobody is on both lists. */
async function list(database: D1Database, side: 'wanted' | 'pets'): Promise<BoardEntry[]> {
  const where = side === 'wanted' ? 'score < 0' : 'score > 0';
  const order = side === 'wanted' ? 'ASC' : 'DESC';
  const { results } = await database
    .prepare(
      `SELECT ${COLUMNS} FROM scores WHERE ${LISTED} AND ${where} ORDER BY score ${order}, uploaded_at ASC LIMIT ?`,
    )
    .bind(BOARD_SIZE)
    .all();
  return results.map((row) => entryOf(row));
}

async function total(database: D1Database): Promise<number> {
  const row = await database.prepare(`SELECT COUNT(*) AS n FROM scores WHERE ${LISTED}`).first();
  return row === null ? 0 : number_(row, 'n');
}

/** An entry and its place counted from the most wanted, or null when it is not listed. */
async function standingOf(database: D1Database, row: Row): Promise<Standing> {
  const entry = entryOf(row);
  if (entry.prompts < MIN_PROMPTS) {
    return { entry, place: null };
  }
  const ahead = await database
    .prepare(
      `SELECT COUNT(*) AS n FROM scores WHERE ${LISTED} AND (score < ? OR (score = ? AND uploaded_at < ?))`,
    )
    .bind(entry.score, entry.score, entry.uploadedAt)
    .first();
  return { entry, place: (ahead === null ? 0 : number_(ahead, 'n')) + 1 };
}

export async function readBoard(database: D1Database, me: string | null): Promise<Board> {
  const [mostWanted, pets, count] = await Promise.all([
    list(database, 'wanted'),
    list(database, 'pets'),
    total(database),
  ]);
  const mine =
    me === null
      ? null
      : await database.prepare(`SELECT ${COLUMNS} FROM scores WHERE entry_id = ?`).bind(me).first();
  return {
    mostWanted,
    pets,
    total: count,
    me: mine === null ? null : await standingOf(database, mine),
  };
}

export type SaveResult =
  | { readonly ok: true; readonly standing: Standing }
  | { readonly ok: false; readonly reason: 'limit' };

/**
 * Saves an upload over the account's last one. The score is worked out here
 * from the counts, so a client cannot send a score that does not match them.
 */
export interface Save {
  readonly account: Account;
  readonly upload: ScoreUpload;
  readonly now: number;
  /** A fresh entry id, used for an account's first upload. */
  readonly newId: () => string;
}

export async function saveScore(database: D1Database, save: Save): Promise<SaveResult> {
  const { account, upload, now, newId } = save;
  const day = utcDay(now);
  const found = await database
    .prepare('SELECT entry_id, upload_day, uploads_today FROM scores WHERE github_id = ?')
    .bind(account.githubId)
    .first();
  const sameDay = found !== null && text(found, 'upload_day') === day;
  const uploadsToday = sameDay ? number_(found, 'uploads_today') : 0;
  if (uploadsToday >= UPLOADS_PER_DAY) {
    return { ok: false, reason: 'limit' };
  }
  const entryId = found === null ? newId() : text(found, 'entry_id');
  const score = reputationScore(upload);
  await database
    .prepare(
      `INSERT INTO scores (github_id, login, entry_id, name, kind, mean, prompts, score, uploaded_at, upload_day, uploads_today, achievements, tokens_per_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (github_id) DO UPDATE SET
         login = excluded.login, name = excluded.name, kind = excluded.kind, mean = excluded.mean,
         prompts = excluded.prompts, score = excluded.score, uploaded_at = excluded.uploaded_at,
         upload_day = excluded.upload_day, uploads_today = excluded.uploads_today,
         achievements = excluded.achievements, tokens_per_day = excluded.tokens_per_day`,
    )
    .bind(
      account.githubId,
      account.login,
      entryId,
      cleanName(upload.name),
      upload.kind,
      upload.mean,
      upload.prompts,
      score,
      now,
      day,
      uploadsToday + 1,
      knownIds(upload.achievements ?? []).join(','),
      upload.tokensPerDay ?? 0,
    )
    .run();
  const row = await database
    .prepare(`SELECT ${COLUMNS} FROM scores WHERE entry_id = ?`)
    .bind(entryId)
    .first();
  if (row === null) {
    throw new Error('the saved score could not be read back');
  }
  return { ok: true, standing: await standingOf(database, row) };
}

export async function removeScore(database: D1Database, account: Account): Promise<void> {
  await database.prepare('DELETE FROM scores WHERE github_id = ?').bind(account.githubId).run();
}
