// Claude Code on the web (cloud) sessions, the list Desktop's Code sidebar
// and `claude --teleport` show. Undocumented: GET /v1/sessions with the CLI's
// own claude.ai sign-in, checked against a real reply in October 2026. The
// token is only read, never refreshed, so the CLI's sign-in is left alone,
// and it never goes into a message or a log.

import path from 'node:path';

import { z } from 'zod';

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { SurfaceSession } from '../../shared/protocol.js';
import type { FileSystem } from '../context/fs.js';
import type { ClaudePaths } from '../paths.js';
import type { Exec } from '../sync/exec.js';
import type { FetchFunction } from '../sync/github.js';

import { lenientArray } from './common.js';
import { handoffsFor } from './handoff.js';
import { pickTitle } from './title.js';

const SESSIONS_URL = 'https://api.anthropic.com/v1/sessions';
const BETA = 'ccr-byoc-2025-07-29';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
// `security` exits 44 when the keychain has no such item.
const KEYCHAIN_NOT_FOUND = 44;
const TIMEOUT_MS = 20_000;

export interface CloudDeps {
  readonly paths: ClaudePaths;
  readonly platform: NodeJS.Platform;
  readonly exec: Exec;
  readonly fetch: FetchFunction;
  readonly readFile: FileSystem['readFile'];
  readonly clock: () => number;
}

export interface CloudSession {
  readonly id: string;
  readonly title: string | null;
  /** idle, running, archived and so on, as the server says it. */
  readonly status: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** "owner/name" of the first GitHub repo the session works in, lowercased. */
  readonly repo: string | null;
}

const credentialsSchema = z.object({
  claudeAiOauth: z
    .object({ accessToken: z.string().min(1), expiresAt: z.number().nullish() })
    .nullish(),
});

const accountSchema = z.object({
  oauthAccount: z.object({ organizationUuid: z.string().nullish() }).nullish(),
});

const sourceSchema = z.object({ type: z.string().nullish(), url: z.string().nullish() });

const sessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullish(),
  session_status: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  session_context: z
    .object({ sources: lenientArray(sourceSchema).nullish() })
    .nullish()
    .catch(null),
});

// data must be a list, so an error reply is not read as no sessions.
const replySchema = z.object({ data: z.array(z.unknown()) });

interface SignIn {
  readonly token: string;
  readonly expiresAt: number | null;
}

/** The CLI's credentials JSON: from the macOS keychain, or the file elsewhere. Null when signed out. */
async function readCredentials(deps: CloudDeps): Promise<string | null> {
  if (deps.platform === 'darwin') {
    const result = await deps.exec(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeoutMs: TIMEOUT_MS },
    );
    if (result.code === KEYCHAIN_NOT_FOUND) {
      return null;
    }
    if (result.code !== 0) {
      throw new Error(
        `could not read the Claude Code sign-in (security exited ${String(result.code)})`,
      );
    }
    return result.stdout;
  }
  return deps.readFile(path.join(deps.paths.configDir, '.credentials.json'));
}

/** The claude.ai sign-in, or null when Claude Code is signed in some other way or not at all. */
export async function readSignIn(deps: CloudDeps): Promise<SignIn | null> {
  const text = await readCredentials(deps);
  if (text === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never echo the text: it holds the token.
    throw new Error('the Claude Code sign-in is not JSON');
  }
  const oauth = credentialsSchema.safeParse(parsed).data?.claudeAiOauth;
  return oauth === undefined || oauth === null
    ? null
    : { token: oauth.accessToken, expiresAt: oauth.expiresAt ?? null };
}

async function organizationUuid(deps: CloudDeps): Promise<string | null> {
  const text = await deps.readFile(deps.paths.claudeJson);
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return accountSchema.safeParse(parsed).data?.oauthAccount?.organizationUuid ?? null;
  } catch {
    return null;
  }
}

function toEpochMs(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

const GITHUB_REPO = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu;

/** "owner/name" from a GitHub https or ssh URL, lowercased, or null. */
export function githubRepo(url: string): string | null {
  const match = GITHUB_REPO.exec(url.trim());
  return match === null ? null : `${match[1] ?? ''}/${match[2] ?? ''}`.toLowerCase();
}

function toCloudSession(raw: z.infer<typeof sessionSchema>): CloudSession {
  const createdAt = toEpochMs(raw.created_at) ?? 0;
  const urls = (raw.session_context?.sources ?? []).flatMap((source) =>
    source.url === null || source.url === undefined ? [] : [source.url],
  );
  return {
    id: raw.id,
    title: raw.title ?? null,
    status: raw.session_status ?? null,
    createdAt,
    updatedAt: toEpochMs(raw.updated_at) ?? createdAt,
    repo: urls.map((url) => githubRepo(url)).find((repo) => repo !== null) ?? null,
  };
}

/** Parse a /v1/sessions reply. Sessions that do not parse are dropped, not fatal. */
export function parseCloudReply(body: unknown): readonly CloudSession[] {
  const reply = replySchema.safeParse(body);
  if (!reply.success) {
    throw new Error('the cloud session list came back in a shape Overlord does not know');
  }
  return reply.data.data.flatMap((item) => {
    const raw = sessionSchema.safeParse(item);
    return raw.success ? [toCloudSession(raw.data)] : [];
  });
}

/**
 * The newest page of cloud sessions. Empty when Claude Code is not signed in
 * with claude.ai. Throws, with nothing secret in the message, when the sign-in
 * has expired or the server refuses.
 */
export async function readCloudSessions(deps: CloudDeps): Promise<readonly CloudSession[]> {
  const signIn = await readSignIn(deps);
  if (signIn === null) {
    return [];
  }
  if (signIn.expiresAt !== null && signIn.expiresAt <= deps.clock()) {
    throw new Error(
      'the Claude Code sign-in has expired, and running any claude command refreshes it',
    );
  }
  const org = await organizationUuid(deps);
  const response = await deps.fetch(SESSIONS_URL, {
    headers: {
      Authorization: `Bearer ${signIn.token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA,
      ...(org === null ? {} : { 'x-organization-uuid': org }),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`the cloud session list failed with HTTP ${String(response.status)}`);
  }
  return parseCloudReply(await response.json());
}

/**
 * The row for a cloud session. cwd is the local checkout of its repo, when
 * one is known, so it groups with that repo and Pull to local runs there.
 * Without one there is nowhere to pull it to.
 */
export function cloudToSurface(session: CloudSession, cwd: string | null): SurfaceSession {
  return {
    id: session.id,
    agent: CLAUDE_CODE,
    surface: 'cloud',
    title: pickTitle(session.title, null, 'Cloud session'),
    cwd,
    updatedAt: session.updatedAt,
    archived: session.status === 'archived',
    handoffs: cwd === null ? [] : handoffsFor({ surface: 'cloud' }),
  };
}

/** The url = values in a git config file. */
function remoteUrls(config: string): string[] {
  return config.split('\n').flatMap((line) => {
    const [key, ...rest] = line.split('=');
    return key?.trim() === 'url' && rest.length > 0 ? [rest.join('=').trim()] : [];
  });
}

/**
 * Local checkouts by GitHub repo, from the folders other sessions ran in.
 * Only folders whose .git is a directory count, so a worktree never stands in
 * for its repository. The first folder found for a repo wins.
 */
export async function checkoutsByRepo(
  folders: readonly string[],
  readFile: FileSystem['readFile'],
): Promise<ReadonlyMap<string, string>> {
  const byRepo = new Map<string, string>();
  for (const folder of new Set(folders)) {
    const config = await readFile(path.join(folder, '.git', 'config'));
    for (const url of remoteUrls(config ?? '')) {
      const repo = githubRepo(url);
      if (repo !== null && !byRepo.has(repo)) {
        byRepo.set(repo, folder);
      }
    }
  }
  return byRepo;
}

type CloudRead =
  | { readonly at: number; readonly sessions: readonly CloudSession[] }
  | { readonly at: number; readonly error: unknown };

/**
 * Cloud sessions read at most once per ttlMs, since the sessions list
 * refreshes every 30 seconds. A failure is kept as long, so a refused
 * sign-in is not retried on every refresh.
 */
export class CloudCache {
  private last: CloudRead | null = null;

  constructor(private readonly ttlMs: number) {}

  async get(deps: CloudDeps): Promise<readonly CloudSession[]> {
    const now = deps.clock();
    if (this.last === null || now - this.last.at >= this.ttlMs) {
      try {
        this.last = { at: now, sessions: await readCloudSessions(deps) };
      } catch (error) {
        this.last = { at: now, error };
      }
    }
    if ('error' in this.last) {
      throw this.last.error;
    }
    return this.last.sessions;
  }
}
