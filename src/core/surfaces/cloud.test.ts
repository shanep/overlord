import { describe, expect, it, vi } from 'vitest';

import { resolveClaudePaths } from '../paths.js';
import type { Exec } from '../sync/exec.js';
import type { FetchFunction } from '../sync/github.js';

import {
  checkoutsByRepo,
  CloudCache,
  cloudToSurface,
  githubRepo,
  parseCloudReply,
  readCloudSessions,
  readSignIn,
} from './cloud.js';
import type { CloudDeps, CloudSession } from './cloud.js';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const TOKEN = 'sk-ant-oat-secret';
const paths = resolveClaudePaths({ home: '/h', platform: 'linux', env: {} });

const credentials = (expiresAt: number | null = NOW + 3_600_000): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'r', expiresAt } });

// Trimmed from a real /v1/sessions reply.
const REPLY = {
  data: [
    {
      id: 'session_01Ubf9',
      title: 'Cloud agent for wt-app issues',
      session_status: 'idle',
      created_at: '2026-10-09T05:00:00Z',
      updated_at: '2026-10-09T06:19:12.710550Z',
      session_context: {
        cwd: '/home/user/wt-apps',
        sources: [{ type: 'git_repository', url: 'https://github.com/acme/wt-apps' }],
      },
    },
    {
      id: 'session_01Nh5d',
      title: '',
      session_status: 'archived',
      created_at: '2026-10-08T05:00:00Z',
      session_context: { sources: [] },
    },
    { id: '', title: 'no id, dropped' },
  ],
  first_id: 'session_01Ubf9',
  last_id: 'session_01Nh5d',
  has_more: false,
};

async function refused(): Promise<Response> {
  await Promise.resolve();
  return Response.json({}, { status: 401 });
}

function files(entries: Record<string, string>): CloudDeps['readFile'] {
  return async (file) => {
    await Promise.resolve();
    return entries[file] ?? null;
  };
}

function deps(overrides: Partial<CloudDeps> = {}): CloudDeps {
  return {
    paths,
    platform: 'linux',
    exec: vi.fn<Exec>(),
    fetch: async (): Promise<Response> => {
      await Promise.resolve();
      return Response.json(REPLY);
    },
    readFile: files({
      '/h/.claude/.credentials.json': credentials(),
      '/h/.claude.json': JSON.stringify({ oauthAccount: { organizationUuid: 'org-1' } }),
    }),
    clock: () => NOW,
    ...overrides,
  };
}

describe('github repos', () => {
  it('reads owner and name from https and ssh URLs', () => {
    expect(githubRepo('https://github.com/Acme/wt-apps')).toBe('acme/wt-apps');
    expect(githubRepo('https://github.com/shanep/overlord.git')).toBe('shanep/overlord');
    expect(githubRepo('git@github.com:shanep/overlord.git')).toBe('shanep/overlord');
    expect(githubRepo('https://gitlab.com/a/b')).toBeNull();
  });

  it('maps repos to the checkouts other sessions ran in, skipping worktrees', async () => {
    const read = files({
      '/w/wt-apps/.git/config': '[remote "origin"]\n\turl = https://github.com/acme/wt-apps.git\n',
      '/w/other-wt-apps/.git/config':
        '[remote "origin"]\n\turl = git@github.com:acme/wt-apps.git\n',
    });
    const map = await checkoutsByRepo(
      ['/w/wt-apps', '/w/wt-apps', '/w/tree', '/w/other-wt-apps'],
      read,
    );
    expect([...map]).toStrictEqual([['acme/wt-apps', '/w/wt-apps']]);
  });
});

describe('cloud replies', () => {
  it('keeps the sessions that parse', () => {
    expect(parseCloudReply(REPLY)).toStrictEqual([
      {
        id: 'session_01Ubf9',
        title: 'Cloud agent for wt-app issues',
        status: 'idle',
        createdAt: Date.parse('2026-10-09T05:00:00Z'),
        updatedAt: Date.parse('2026-10-09T06:19:12.710Z'),
        repo: 'acme/wt-apps',
      },
      {
        id: 'session_01Nh5d',
        title: '',
        status: 'archived',
        createdAt: Date.parse('2026-10-08T05:00:00Z'),
        updatedAt: Date.parse('2026-10-08T05:00:00Z'),
        repo: null,
      },
    ]);
  });

  it('refuses a reply with no session list', () => {
    expect(() => parseCloudReply({ error: 'nope' })).toThrow('shape Overlord does not know');
  });

  it('offers Pull to local only when the repo has a checkout here', () => {
    const [found, archived] = parseCloudReply(REPLY) as [CloudSession, CloudSession];
    expect(cloudToSurface(found, '/w/wt-apps')).toStrictEqual({
      id: 'session_01Ubf9',
      agent: 'claude-code',
      surface: 'cloud',
      title: 'Cloud agent for wt-app issues',
      cwd: '/w/wt-apps',
      updatedAt: found.updatedAt,
      archived: false,
      handoffs: ['teleport-local'],
    });
    expect(cloudToSurface(archived, null)).toMatchObject({
      title: 'Cloud session',
      archived: true,
      handoffs: [],
    });
  });
});

describe('reading cloud sessions', () => {
  it('asks the sessions API with the sign-in and organization', async () => {
    const fetch = vi.fn<FetchFunction>(async () => {
      await Promise.resolve();
      return Response.json(REPLY);
    });
    const sessions = await readCloudSessions(deps({ fetch }));
    expect(sessions.map((session) => session.id)).toStrictEqual([
      'session_01Ubf9',
      'session_01Nh5d',
    ]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/sessions');
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': 'org-1',
    });
  });

  it('reads the macOS keychain, and lists nothing when the item is missing', async () => {
    const exec = vi.fn<Exec>(async () => {
      await Promise.resolve();
      return { code: 0, stdout: credentials(), stderr: '' };
    });
    expect(await readSignIn(deps({ platform: 'darwin', exec }))).toStrictEqual({
      token: TOKEN,
      expiresAt: NOW + 3_600_000,
    });
    expect(exec).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeoutMs: 20_000 },
    );
    const missing = vi.fn<Exec>(async () => {
      await Promise.resolve();
      return { code: 44, stdout: '', stderr: 'not found' };
    });
    const fetch = vi.fn<FetchFunction>();
    expect(
      await readCloudSessions(deps({ platform: 'darwin', exec: missing, fetch })),
    ).toStrictEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists nothing without a claude.ai sign-in', async () => {
    const fetch = vi.fn<FetchFunction>();
    expect(await readCloudSessions(deps({ readFile: files({}), fetch }))).toStrictEqual([]);
    const apiKeyOnly = files({ '/h/.claude/.credentials.json': '{}' });
    expect(await readCloudSessions(deps({ readFile: apiKeyOnly, fetch }))).toStrictEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails without the token in the message', async () => {
    const expired = files({ '/h/.claude/.credentials.json': credentials(NOW - 1) });
    await expect(readCloudSessions(deps({ readFile: expired }))).rejects.toThrow('has expired');
    await expect(readCloudSessions(deps({ fetch: refused }))).rejects.toThrow('HTTP 401');
    const garbled = files({ '/h/.claude/.credentials.json': `${TOKEN} not json` });
    const error = await readSignIn(deps({ readFile: garbled })).catch((error_: unknown) => error_);
    expect(String(error)).not.toContain(TOKEN);
    const locked = vi.fn<Exec>(async () => {
      await Promise.resolve();
      return { code: 51, stdout: '', stderr: '' };
    });
    await expect(readSignIn(deps({ platform: 'darwin', exec: locked }))).rejects.toThrow(
      'exited 51',
    );
  });

  it('asks again only after the cache runs out, failures included', async () => {
    let now = NOW;
    let status = 200;
    const fetch = vi.fn<FetchFunction>(async () => {
      await Promise.resolve();
      return status === 200 ? Response.json(REPLY) : Response.json({}, { status });
    });
    const cache = new CloudCache(1000);
    const read = deps({ fetch, clock: () => now });
    expect(await cache.get(read)).toHaveLength(2);
    now += 999;
    expect(await cache.get(read)).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 1;
    status = 500;
    await expect(cache.get(read)).rejects.toThrow('HTTP 500');
    await expect(cache.get(read)).rejects.toThrow('HTTP 500');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
