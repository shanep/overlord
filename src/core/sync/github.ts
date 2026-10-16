// The GitHub side of config sync: find or create the user's private config
// repo through the REST API, and hand git the same token over HTTPS. The
// token comes from the editor's GitHub sign-in, so no SSH key or personal
// access token is needed on a new machine.

import { z } from 'zod';

import type { GitAuth } from './git.js';
import { parseJson } from './json.js';
import { remoteSlug } from './layout.js';

/** The name of the repo Overlord makes when the user has none configured. */
export const CONFIG_REPO_NAME = 'claude-config';

const API = 'https://api.github.com';
const NOT_FOUND = 404;

/** The slice of the global fetch these calls use, so tests can answer without a network. */
export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubRepo {
  readonly fullName: string;
  readonly cloneUrl: string;
  /** True when this call made the repo. */
  readonly created: boolean;
}

const userSchema = z.object({ login: z.string().min(1) });
const repoSchema = z.object({ full_name: z.string().min(1), clone_url: z.string().min(1) });

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'overlord',
  };
}

async function failure(response: Response, what: string): Promise<Error> {
  const body = await response.text();
  const parsed = z.object({ message: z.string() }).safeParse(parseJson(body));
  const detail = parsed.success ? parsed.data.message : response.statusText;
  return new Error(`GitHub would not ${what} (${String(response.status)}): ${detail}`);
}

async function readRepo(response: Response, created: boolean): Promise<GitHubRepo> {
  const repo = repoSchema.parse(await response.json());
  return { fullName: repo.full_name, cloneUrl: repo.clone_url, created };
}

/** The signed in user's login. */
export async function gitHubLogin(fetchFunction: FetchFunction, token: string): Promise<string> {
  const response = await fetchFunction(`${API}/user`, { headers: headers(token) });
  if (!response.ok) {
    throw await failure(response, 'say who is signed in');
  }
  return userSchema.parse(await response.json()).login;
}

/** The user's repo called `name`, made private and empty when it is not there yet. */
export async function findOrCreateRepo(
  fetchFunction: FetchFunction,
  token: string,
  name: string,
): Promise<GitHubRepo> {
  const login = await gitHubLogin(fetchFunction, token);
  const found = await fetchFunction(`${API}/repos/${login}/${name}`, { headers: headers(token) });
  if (found.ok) {
    return readRepo(found, false);
  }
  if (found.status !== NOT_FOUND) {
    throw await failure(found, `look up ${login}/${name}`);
  }
  const made = await fetchFunction(`${API}/user/repos`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      private: true,
      description: 'Claude Code config, kept in sync by Overlord.',
    }),
  });
  if (!made.ok) {
    throw await failure(made, `create ${login}/${name}`);
  }
  return readRepo(made, true);
}

/** True for an https URL on github.com, the only kind the editor's token signs in. */
export function isGitHubHttps(url: string): boolean {
  return /^https:\/\//iu.test(url) && remoteSlug(url)?.startsWith('github.com/') === true;
}

/**
 * Variables that make git send the token to github.com over HTTPS. Git reads
 * them as config (GIT_CONFIG_COUNT, git 2.31 and later), so the token never
 * lands on a command line or in the clone's .git/config.
 */
export function gitHubAuthEnv(token: string): GitAuth {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}
