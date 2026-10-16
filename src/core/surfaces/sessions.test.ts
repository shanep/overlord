import { describe, expect, it, vi } from 'vitest';

import type { Surface } from '../../shared/model.js';
import type { SurfaceSession } from '../../shared/protocol.js';

import { parseClaudeAiExport } from './claude-ai-export.js';
import type { LiveProcess } from './live.js';
import type { ExecFunction } from './process.js';
import {
  dedupeSessions,
  listAllSessions,
  liveToSurface,
  surfaceForEntrypoint,
} from './sessions.js';
import { DESKTOP, makeScratchHome } from './test-helpers/scratch-home.js';

function row(overrides: Partial<SurfaceSession>): SurfaceSession {
  return {
    id: 'id',
    surface: 'cli',
    title: 'title',
    cwd: null,
    updatedAt: 0,
    archived: false,
    handoffs: [],
    ...overrides,
  };
}

function live(overrides: Partial<LiveProcess> = {}): LiveProcess {
  return {
    sessionId: 's1',
    pid: 1,
    alive: true,
    state: null,
    status: 'idle',
    kind: 'interactive',
    name: null,
    cwd: '/w/repo',
    entrypoint: 'cli',
    version: null,
    startedAt: 10,
    updatedAt: 20,
    agentId: null,
    messagingSocketPath: null,
    sources: ['registry'],
    ...overrides,
  };
}

const noAgents = (): ExecFunction => vi.fn<ExecFunction>().mockResolvedValue({ stdout: '[]' });

describe('surfaceForEntrypoint', () => {
  it('maps registry entrypoints to surfaces', () => {
    expect(surfaceForEntrypoint(null)).toBe('cli');
    expect(surfaceForEntrypoint('cli')).toBe('cli');
    expect(surfaceForEntrypoint('sdk-ts')).toBe('sdk');
    expect(surfaceForEntrypoint('sdk-py')).toBe('sdk');
    expect(surfaceForEntrypoint('sdk-cli')).toBe('sdk');
    expect(surfaceForEntrypoint('claude-desktop')).toBe('desktop-code');
    expect(surfaceForEntrypoint('claude-vscode')).toBe('cli');
    expect(surfaceForEntrypoint('my-sdk')).toBe('cli');
  });
});

describe('liveToSurface', () => {
  it('builds a CLI row with local handoffs', () => {
    expect(liveToSurface(live({ name: 'named' }))).toStrictEqual({
      id: 's1',
      surface: 'cli',
      title: 'named',
      cwd: '/w/repo',
      updatedAt: 20,
      archived: false,
      handoffs: ['resume-local', 'open-desktop', 'remote-control'],
    });
  });

  it('falls back on title and time', () => {
    expect(liveToSurface(live()).title).toBe('repo');
    expect(liveToSurface(live({ cwd: null })).title).toBe('s1');
    expect(liveToSurface(live({ updatedAt: null })).updatedAt).toBe(10);
    expect(liveToSurface(live({ updatedAt: null, startedAt: null })).updatedAt).toBe(0);
  });

  it('gives SDK and Desktop processes their surfaces and handoffs', () => {
    expect(liveToSurface(live({ entrypoint: 'sdk-ts' })).surface).toBe('sdk');
    const desktop = liveToSurface(live({ entrypoint: 'claude-desktop' }));
    expect(desktop.surface).toBe('desktop-code');
    expect(desktop.handoffs).toStrictEqual(['resume-local', 'open-desktop']);
  });
});

describe('dedupeSessions', () => {
  it('sorts newest first, then by id', () => {
    const sorted = dedupeSessions([
      row({ id: 'b', updatedAt: 1 }),
      row({ id: 'c', updatedAt: 5 }),
      row({ id: 'a', updatedAt: 1 }),
    ]);
    expect(sorted.map((session) => session.id)).toStrictEqual(['c', 'a', 'b']);
  });

  it('keeps the Desktop row over its CLI twin, in either order', () => {
    const cli = row({ id: 'x', surface: 'cli', title: 'cli', cwd: '/cli', updatedAt: 9 });
    const desk = row({ id: 'x', surface: 'desktop-code', title: 'desk', cwd: null, updatedAt: 3 });
    const expected = row({
      id: 'x',
      surface: 'desktop-code',
      title: 'desk',
      cwd: '/cli',
      updatedAt: 9,
    });
    expect(dedupeSessions([cli, desk])).toStrictEqual([expected]);
    expect(dedupeSessions([desk, cli])).toStrictEqual([expected]);
  });

  it('keeps the winner cwd when it has one', () => {
    const cli = row({ id: 'x', surface: 'cli', cwd: '/cli' });
    const over = row({ id: 'x', surface: 'overlord', cwd: '/over' });
    expect(dedupeSessions([cli, over])[0]?.cwd).toBe('/over');
  });

  it('ranks surfaces from least to most specific', () => {
    const order: readonly Surface[] = [
      'cli',
      'sdk',
      'overlord',
      'cloud',
      'cowork',
      'desktop-code',
      'claude-ai',
    ];
    for (const [index, lower] of order.entries()) {
      for (const higher of order.slice(index + 1)) {
        const merged = dedupeSessions([
          row({ id: 'x', surface: higher }),
          row({ id: 'x', surface: lower }),
        ]);
        expect(merged.map((session) => session.surface)).toStrictEqual([higher]);
      }
    }
  });

  it('keeps the first row when two rows share a surface', () => {
    const first = row({ id: 'x', title: 'first' });
    const second = row({ id: 'x', title: 'second' });
    expect(dedupeSessions([first, second])[0]?.title).toBe('first');
  });

  it('follows aliases to the row they belong to', () => {
    const cowork = row({ id: 'local_c', surface: 'cowork', updatedAt: 1 });
    const cli = row({ id: 'cli-c', surface: 'cli', updatedAt: 7 });
    const merged = dedupeSessions([cli, cowork], new Map([['cli-c', 'local_c']]));
    expect(merged).toStrictEqual([{ ...cowork, updatedAt: 7 }]);
  });
});

describe('listAllSessions', () => {
  it('combines every source into one deduped list', async () => {
    const home = await makeScratchHome();
    await home.writeJson('.claude/sessions/10.json', {
      pid: 10,
      sessionId: 'cli-desk',
      cwd: '/w/desk',
      updatedAt: 500,
      entrypoint: 'cli',
    });
    await home.writeJson('.claude/sessions/11.json', {
      pid: 11,
      sessionId: 'plain-cli',
      cwd: '/w/plain',
      updatedAt: 300,
    });
    await home.writeJson(`${DESKTOP}/claude-code-sessions/a/o/local_d.json`, {
      sessionId: 'local_d',
      cliSessionId: 'cli-desk',
      cwd: '/w/desk',
      title: 'Desk title',
      createdAt: 100,
      lastActivityAt: 200,
    });
    await home.writeJson(`${DESKTOP}/claude-code-sessions/a/o/local_bad.json`, { nope: 1 });
    await home.writeJson(`${DESKTOP}/local-agent-mode-sessions/a/o/local_c.json`, {
      sessionId: 'local_c',
      cliSessionId: 'cowork-cli',
      title: 'Cowork title',
      createdAt: 50,
      lastActivityAt: 60,
    });
    const exec = vi.fn<ExecFunction>().mockResolvedValue({
      stdout: JSON.stringify([{ sessionId: 'cowork-cli', pid: 99, startedAt: 70 }]),
    });
    const claudeAi = parseClaudeAiExport([
      { uuid: 'chat-1', name: 'Chat', updated_at: '1970-01-01T00:00:00.400Z' },
    ]).conversations;
    const cloud = row({ id: 'cloud-1', surface: 'cloud', updatedAt: 450, title: 'Cloud' });
    const result = await listAllSessions({
      paths: home.paths,
      exec,
      isAlive: (pid) => pid === 10,
      agentsOptions: { claudeBin: 'cc' },
      claudeAi,
      extraSources: [
        {
          name: 'cloud',
          load: vi.fn<() => Promise<readonly SurfaceSession[]>>().mockResolvedValue([cloud]),
        },
        {
          name: 'transcripts',
          load: async (): Promise<SurfaceSession[]> => {
            await Promise.resolve();
            throw new Error('index busy');
          },
        },
      ],
    });
    expect(result.sessions.map((session) => [session.id, session.surface])).toStrictEqual([
      ['cli-desk', 'desktop-code'],
      ['cloud-1', 'cloud'],
      ['chat-1', 'claude-ai'],
      ['plain-cli', 'cli'],
      ['local_c', 'cowork'],
    ]);
    const desk = result.sessions[0];
    expect(desk).toStrictEqual({
      id: 'cli-desk',
      surface: 'desktop-code',
      title: 'Desk title',
      cwd: '/w/desk',
      updatedAt: 500,
      archived: false,
      handoffs: ['resume-local', 'open-desktop'],
    });
    expect(result.sessions[4]?.updatedAt).toBe(70);
    expect([...result.live.keys()]).toStrictEqual(['cli-desk', 'plain-cli', 'cowork-cli']);
    expect(result.live.get('cli-desk')?.alive).toBe(true);
    expect(result.desktop.map((session) => session.desktopId)).toStrictEqual(['local_d']);
    expect(result.cowork.map((session) => session.id)).toStrictEqual(['local_c']);
    expect([...result.desktopByCliSession.entries()]).toStrictEqual([['cli-desk', 'local_d']]);
    expect(result.errors.map((error) => [error.source, error.message])).toStrictEqual([
      ['desktop-code', expect.stringMatching(/^unexpected shape/u)],
      ['transcripts', 'index busy'],
    ]);
    expect(exec).toHaveBeenCalledWith('cc', ['agents', '--json'], { timeoutMs: 5000 });
    await home.cleanup();
  });

  it('lists a Cowork session that has no CLI id', async () => {
    const home = await makeScratchHome();
    await home.writeJson(`${DESKTOP}/local-agent-mode-sessions/a/o/local_n.json`, {
      sessionId: 'local_n',
      createdAt: 5,
    });
    await home.writeJson('.claude/sessions/3.json', { pid: 3, sessionId: 'local_n-cli' });
    const result = await listAllSessions({
      paths: home.paths,
      exec: noAgents(),
      isAlive: () => true,
    });
    expect(result.sessions.map((session) => [session.id, session.surface])).toStrictEqual([
      ['local_n', 'cowork'],
      ['local_n-cli', 'cli'],
    ]);
    await home.cleanup();
  });

  it('works with only the required deps and on Linux', async () => {
    const home = await makeScratchHome('linux');
    const exec = noAgents();
    const result = await listAllSessions({ paths: home.paths, exec, isAlive: () => false });
    expect(result).toStrictEqual({
      sessions: [],
      live: new Map<string, LiveProcess>(),
      desktop: [],
      cowork: [],
      desktopByCliSession: new Map<string, string>(),
      errors: [],
    });
    expect(exec).toHaveBeenCalledWith('claude', ['agents', '--json'], { timeoutMs: 5000 });
    await home.cleanup();
  });

  it('reports unreadable Desktop dirs without losing other sources', async () => {
    const home = await makeScratchHome();
    // A Desktop dir that is a file cannot be listed.
    await home.writeText(`${DESKTOP}/claude-code-sessions`, 'file');
    await home.writeText(`${DESKTOP}/local-agent-mode-sessions`, 'file');
    await home.writeJson('.claude/sessions/1.json', { pid: 1, sessionId: 'kept' });
    const result = await listAllSessions({
      paths: home.paths,
      exec: noAgents(),
      isAlive: () => true,
    });
    expect(result.sessions.map((session) => session.id)).toStrictEqual(['kept']);
    expect(result.errors.map((error) => error.source)).toStrictEqual(['desktop-code', 'cowork']);
    await home.cleanup();
  });
});
