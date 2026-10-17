// D1 backed by an in-memory SQLite database with the real migration applied,
// so tests run the Worker's actual SQL.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { D1Database, D1Statement, Row } from '../store.js';

const MIGRATION = new URL('../../../leaderboard/migrations/0001_scores.sql', import.meta.url);

export function fakeD1(): D1Database {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(MIGRATION, 'utf8'));
  const statement = (sql: string, values: readonly (string | number)[]): D1Statement => ({
    bind: (...next) => statement(sql, next),
    first: async (): Promise<Row | null> => {
      await Promise.resolve();
      return database.prepare(sql).get(...values) ?? null;
    },
    all: async (): Promise<{ readonly results: readonly Row[] }> => {
      await Promise.resolve();
      return { results: database.prepare(sql).all(...values) };
    },
    run: async (): Promise<unknown> => {
      await Promise.resolve();
      return database.prepare(sql).run(...values);
    },
  });
  return { prepare: (sql) => statement(sql, []) };
}

/** GitHub's /user endpoint for a few known tokens. Anything else is a bad credential. */
const GITHUB_USERS: Readonly<Record<string, { readonly id: number; readonly login: string }>> = {
  'token-ann': { id: 1, login: 'ann' },
  'token-bob': { id: 2, login: 'bob' },
  'token-cat': { id: 3, login: 'cat' },
};

export async function fakeGitHub(init: RequestInit): Promise<Response> {
  await Promise.resolve();
  const auth = new Headers(init.headers).get('authorization') ?? '';
  const user = GITHUB_USERS[auth.replace('Bearer ', '')];
  return user === undefined
    ? new Response('{"message":"Bad credentials"}', { status: 401 })
    : Response.json({ ...user, email: 'hidden@example.com' });
}
