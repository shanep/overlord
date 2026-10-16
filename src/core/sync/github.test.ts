import { describe, expect, it } from 'vitest';

import {
  CONFIG_REPO_NAME,
  findOrCreateRepo,
  gitHubAuthEnv,
  gitHubLogin,
  isGitHubHttps,
  type FetchFunction,
} from './github.js';
import { git, isolatedExec, repoWith } from './test-helpers/fixtures.js';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

function answering(...responses: Response[]): { fetch: FetchFunction; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: FetchFunction = async (url, init) => {
    const authorization = new Headers(init.headers).get('Authorization');
    seen.push({ method: init.method ?? 'GET', url, authorization });
    await Promise.resolve();
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`no answer for ${url}`);
    }
    return next;
  };
  return { fetch, seen };
}

const REPO = {
  full_name: 'me/overlord-config',
  clone_url: 'https://github.com/me/overlord-config.git',
};

describe('gitHubLogin', () => {
  it('reads the login and sends the token', async () => {
    const { fetch, seen } = answering(Response.json({ login: 'me' }));
    await expect(gitHubLogin(fetch, 'tok')).resolves.toBe('me');
    expect(seen[0]?.authorization).toBe('Bearer tok');
    expect(seen[0]?.url).toBe('https://api.github.com/user');
  });

  it("reports GitHub's message, or the status text without one", async () => {
    const bad = answering(Response.json({ message: 'Bad credentials' }, { status: 401 }));
    await expect(gitHubLogin(bad.fetch, 'tok')).rejects.toThrow(
      'GitHub would not say who is signed in (401): Bad credentials',
    );
    const plain = answering(new Response('oops', { status: 500, statusText: 'Server Error' }));
    await expect(gitHubLogin(plain.fetch, 'tok')).rejects.toThrow(
      'GitHub would not say who is signed in (500): Server Error',
    );
  });
});

describe('findOrCreateRepo', () => {
  it('returns the repo that is already there', async () => {
    const { fetch, seen } = answering(Response.json({ login: 'me' }), Response.json(REPO));
    await expect(findOrCreateRepo(fetch, 'tok', CONFIG_REPO_NAME)).resolves.toStrictEqual({
      fullName: 'me/overlord-config',
      cloneUrl: 'https://github.com/me/overlord-config.git',
      created: false,
    });
    expect(seen.map((call) => call.url)).toStrictEqual([
      'https://api.github.com/user',
      'https://api.github.com/repos/me/overlord-config',
    ]);
  });

  it('creates it private when it is missing', async () => {
    const { fetch, seen } = answering(
      Response.json({ login: 'me' }),
      Response.json({ message: 'Not Found' }, { status: 404 }),
      Response.json(REPO, { status: 201 }),
    );
    const repo = await findOrCreateRepo(fetch, 'tok', CONFIG_REPO_NAME);
    expect(repo.created).toBe(true);
    expect(seen[2]).toMatchObject({ method: 'POST', url: 'https://api.github.com/user/repos' });
  });

  it('stops on a lookup error and on a failed create', async () => {
    const lookup = answering(
      Response.json({ login: 'me' }),
      Response.json({ message: 'Forbidden' }, { status: 403 }),
    );
    await expect(findOrCreateRepo(lookup.fetch, 'tok', 'c')).rejects.toThrow(
      'GitHub would not look up me/c (403): Forbidden',
    );
    const create = answering(
      Response.json({ login: 'me' }),
      Response.json({}, { status: 404 }),
      Response.json({ message: 'name already exists' }, { status: 422 }),
    );
    await expect(findOrCreateRepo(create.fetch, 'tok', 'c')).rejects.toThrow(
      'GitHub would not create me/c (422): name already exists',
    );
  });
});

describe('isGitHubHttps', () => {
  it('is true only for https URLs on github.com', () => {
    expect(isGitHubHttps('https://github.com/me/c.git')).toBe(true);
    expect(isGitHubHttps('HTTPS://GitHub.com/me/c')).toBe(true);
    expect(isGitHubHttps('git@github.com:me/c.git')).toBe(false);
    expect(isGitHubHttps('https://gitlab.com/me/c.git')).toBe(false);
    expect(isGitHubHttps('/local/c.git')).toBe(false);
  });
});

describe('gitHubAuthEnv', () => {
  it('gives git an auth header for github.com only, outside its config files', async () => {
    const exec = isolatedExec();
    const repo = await repoWith(exec, { a: 'a' });
    const env = gitHubAuthEnv('tok') ?? {};
    const result = await exec(
      'git',
      ['-C', repo, 'config', '--get', 'http.https://github.com/.extraheader'],
      { env },
    );
    const basic = Buffer.from('x-access-token:tok').toString('base64');
    expect(result.stdout.trim()).toBe(`AUTHORIZATION: basic ${basic}`);
    const stored = await git(exec, repo, ['config', '--list', '--local']);
    expect(stored).not.toContain('extraheader');
  });
});
