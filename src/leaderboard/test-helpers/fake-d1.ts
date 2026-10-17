// D1 backed by an in-memory SQLite database with the real migrations applied,
// so tests run the Worker's actual SQL.

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { D1Database, D1Statement, Row } from '../store.js';

const MIGRATIONS = new URL('../../../leaderboard/migrations/', import.meta.url);

export function fakeD1(): D1Database {
  const database = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .toSorted((a, b) => a.localeCompare(b))) {
    database.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
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
