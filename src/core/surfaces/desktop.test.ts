import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  desktopCliSessionMap,
  desktopCodeRoot,
  desktopCodeToSurface,
  readDesktopCodeSessions,
  transcriptPathFor,
} from './desktop.js';
import type { DesktopCodeSession } from './desktop.js';
import { DESKTOP, makeScratchHome } from './test-helpers/scratch-home.js';

const DIR = `${DESKTOP}/claude-code-sessions/acct/org`;

const FULL = {
  sessionId: 'local_one',
  cliSessionId: 'cli-1',
  cwd: '/Users/me/repo',
  originCwd: '/Users/me/origin',
  title: 'Refactor parser',
  createdAt: 100,
  lastActivityAt: 200,
  isArchived: true,
  model: 'claude-opus-5',
  permissionMode: 'acceptEdits',
  effort: 'high',
  completedTurns: 4,
  enabledMcpTools: {},
  postTurnSummary: { status_category: 'x' },
};

function desktopSession(overrides: Partial<DesktopCodeSession> = {}): DesktopCodeSession {
  return {
    desktopId: 'local_d',
    cliSessionId: 'cli-d',
    cwd: '/w/proj',
    originCwd: null,
    title: 'T',
    createdAt: 1,
    lastActivityAt: 2,
    archived: false,
    model: null,
    permissionMode: null,
    effort: null,
    completedTurns: null,
    transcriptPath: null,
    filePath: '/f.json',
    ...overrides,
  };
}

describe('desktopCodeRoot', () => {
  it('is under the Desktop dir, and null on Linux', async () => {
    const mac = await makeScratchHome('darwin');
    expect(desktopCodeRoot(mac.paths)).toBe(path.join(mac.root, DESKTOP, 'claude-code-sessions'));
    const linux = await makeScratchHome('linux');
    expect(desktopCodeRoot(linux.paths)).toBeNull();
    await mac.cleanup();
    await linux.cleanup();
  });
});

describe('transcriptPathFor', () => {
  it('uses the encoded project dir', async () => {
    const home = await makeScratchHome();
    expect(transcriptPathFor(home.paths, '/Users/me/my.repo', 'abc')).toBe(
      path.join(home.root, '.claude', 'projects', '-Users-me-my-repo', 'abc.jsonl'),
    );
    await home.cleanup();
  });
});

describe('readDesktopCodeSessions', () => {
  it('is empty on Linux with no errors', async () => {
    const home = await makeScratchHome('linux');
    await home.writeJson(`${DIR}/local_one.json`, FULL);
    await expect(readDesktopCodeSessions(home.paths)).resolves.toStrictEqual({
      items: [],
      errors: [],
    });
    await home.cleanup();
  });

  it('is empty when Desktop has no sessions dir', async () => {
    const home = await makeScratchHome();
    await expect(readDesktopCodeSessions(home.paths)).resolves.toStrictEqual({
      items: [],
      errors: [],
    });
    await home.cleanup();
  });

  it('reads every field it knows', async () => {
    const home = await makeScratchHome();
    const file = await home.writeJson(`${DIR}/local_one.json`, FULL);
    const result = await readDesktopCodeSessions(home.paths);
    expect(result.errors).toStrictEqual([]);
    expect(result.items).toStrictEqual([
      {
        desktopId: 'local_one',
        cliSessionId: 'cli-1',
        cwd: '/Users/me/repo',
        originCwd: '/Users/me/origin',
        title: 'Refactor parser',
        createdAt: 100,
        lastActivityAt: 200,
        archived: true,
        model: 'claude-opus-5',
        permissionMode: 'acceptEdits',
        effort: 'high',
        completedTurns: 4,
        transcriptPath: path.join(home.paths.projectsDir, '-Users-me-repo', 'cli-1.jsonl'),
        filePath: file,
      },
    ]);
    await home.cleanup();
  });

  it('fills defaults for a minimal file', async () => {
    const home = await makeScratchHome();
    const file = await home.writeJson(`${DIR}/local_min.json`, {
      sessionId: 'local_min',
      createdAt: 50,
      title: null,
    });
    const result = await readDesktopCodeSessions(home.paths);
    expect(result.items).toStrictEqual([
      {
        desktopId: 'local_min',
        cliSessionId: null,
        cwd: null,
        originCwd: null,
        title: null,
        createdAt: 50,
        lastActivityAt: 50,
        archived: false,
        model: null,
        permissionMode: null,
        effort: null,
        completedTurns: null,
        transcriptPath: null,
        filePath: file,
      },
    ]);
    await home.cleanup();
  });

  it('has no transcript path without a cwd or without a CLI id', async () => {
    const home = await makeScratchHome();
    await home.writeJson(`${DIR}/local_a.json`, { sessionId: 'a', createdAt: 1, cwd: '/x' });
    await home.writeJson(`${DIR}/local_b.json`, {
      sessionId: 'b',
      createdAt: 1,
      cliSessionId: 'c',
    });
    const result = await readDesktopCodeSessions(home.paths);
    expect(result.items.map((item) => item.transcriptPath)).toStrictEqual([null, null]);
    await home.cleanup();
  });

  it('reports bad files without dropping good ones', async () => {
    const home = await makeScratchHome();
    await home.writeJson(`${DIR}/local_ok.json`, { sessionId: 'ok', createdAt: 1 });
    const bad = await home.writeJson(`${DIR}/local_bad.json`, { sessionId: 'bad' });
    const result = await readDesktopCodeSessions(home.paths);
    expect(result.items.map((item) => item.desktopId)).toStrictEqual(['ok']);
    expect(result.errors.map((error) => [error.source, error.path])).toStrictEqual([
      ['desktop-code', bad],
    ]);
    await home.cleanup();
  });
});

describe('desktopCodeToSurface', () => {
  it('uses the CLI session id so the row matches the transcript', () => {
    expect(desktopCodeToSurface(desktopSession({ archived: true }))).toStrictEqual({
      id: 'cli-d',
      agent: 'claude-code',
      surface: 'desktop-code',
      title: 'T',
      cwd: '/w/proj',
      updatedAt: 2,
      archived: true,
      handoffs: ['resume-local', 'open-desktop'],
    });
  });

  it('falls back to the Desktop id with no handoffs when there is no CLI id', () => {
    const row = desktopCodeToSurface(desktopSession({ cliSessionId: null }));
    expect(row.id).toBe('local_d');
    expect(row.handoffs).toStrictEqual([]);
  });

  it('titles untitled sessions from the cwd, then a fixed label', () => {
    expect(desktopCodeToSurface(desktopSession({ title: null })).title).toBe('proj');
    expect(desktopCodeToSurface(desktopSession({ title: null, cwd: null })).title).toBe(
      'Desktop session',
    );
  });
});

describe('desktopCliSessionMap', () => {
  it('maps CLI ids to Desktop ids and skips sessions without one', () => {
    const map = desktopCliSessionMap([
      desktopSession({ desktopId: 'local_1', cliSessionId: 'c1' }),
      desktopSession({ desktopId: 'local_2', cliSessionId: null }),
      desktopSession({ desktopId: 'local_3', cliSessionId: 'c3' }),
    ]);
    expect([...map.entries()]).toStrictEqual([
      ['c1', 'local_1'],
      ['c3', 'local_3'],
    ]);
  });
});
