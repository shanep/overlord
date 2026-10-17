import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../bus.js';
import { OverlordStore } from '../../store/store.js';
import { CloudCache } from '../../surfaces/cloud.js';
import type { CloudDeps } from '../../surfaces/cloud.js';
import { toSurfacesExec } from '../process.js';
import {
  immediateScheduler,
  makeEnv,
  NOW,
  ok,
  recordingExec,
  writeText,
} from '../test-helpers/fixtures.js';

import { loadSessions, PeekCache } from './sessions.js';

const REPLY = {
  data: [
    {
      id: 'session_here',
      title: 'Fix the axle report',
      session_status: 'idle',
      updated_at: new Date(NOW).toISOString(),
      session_context: {
        sources: [{ type: 'git_repository', url: 'https://github.com/acme/wt-apps' }],
      },
    },
    {
      id: 'session_elsewhere',
      title: 'Somebody else repo',
      session_status: 'archived',
      updated_at: new Date(NOW - 1000).toISOString(),
      session_context: { sources: [{ url: 'https://github.com/other/thing' }] },
    },
  ],
};

describe('cloud sessions in the sessions view', () => {
  it('lists them in the checkout of their repo, and reports a failure', async () => {
    const env = await makeEnv();
    await writeText(
      path.join(env.paths.projectsDir, '-w-wt-apps', 'local-one.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: '/w/wt-apps', message: { role: 'user', content: 'x' } })}\n`,
    );
    const known: Record<string, string> = {
      [path.join(env.paths.configDir, '.credentials.json')]: JSON.stringify({
        claudeAiOauth: { accessToken: 'token', expiresAt: NOW + 60_000 },
      }),
      '/w/wt-apps/.git/config': '[remote "origin"]\n\turl = git@github.com:acme/wt-apps.git\n',
    };
    let status = 200;
    const cloudDeps: CloudDeps = {
      paths: env.paths,
      platform: 'linux',
      exec: vi.fn(),
      fetch: async () => {
        await Promise.resolve();
        return status === 200 ? Response.json(REPLY) : Response.json({}, { status });
      },
      readFile: async (file) => {
        await Promise.resolve();
        return known[file] ?? null;
      },
      clock: () => NOW,
    };
    const { exec } = recordingExec((call) => (call.command === 'claude' ? ok('[]') : undefined));
    const report = vi.fn<(source: string, message: string) => void>();
    const load = async (cache: CloudCache): ReturnType<typeof loadSessions> =>
      loadSessions({
        paths: env.paths,
        exec: toSurfacesExec(exec),
        isAlive: () => false,
        claudeBin: 'claude',
        store: new OverlordStore(new EventBus(), { scheduler: immediateScheduler }),
        clock: () => NOW,
        importFile: path.join(env.storageDir, 'claude-ai.json'),
        report,
        peeks: new PeekCache(),
        cloud: { cache, deps: cloudDeps },
      });

    const data = await load(new CloudCache(1000));
    const rows = Object.fromEntries(
      data.sessions.map((row) => [row.id, [row.surface, row.cwd, row.archived, row.handoffs]]),
    );
    expect(rows).toStrictEqual({
      session_here: ['cloud', '/w/wt-apps', false, ['teleport-local']],
      session_elsewhere: ['cloud', null, true, []],
      'local-one': ['cli', '/w/wt-apps', false, ['resume-local', 'open-desktop', 'remote-control']],
    });
    expect(report).not.toHaveBeenCalled();

    status = 401;
    const failed = await load(new CloudCache(1000));
    expect(failed.sessions.map((row) => row.id)).toStrictEqual(['local-one']);
    expect(report).toHaveBeenCalledWith(
      'sessions',
      'cloud: the cloud session list failed with HTTP 401',
    );
  });
});
