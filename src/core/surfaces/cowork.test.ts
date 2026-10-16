import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { coworkRoot, coworkToSurface, readCoworkSessions } from './cowork.js';
import type { CoworkSession } from './cowork.js';
import { DESKTOP, makeScratchHome } from './test-helpers/scratch-home.js';

const DIR = `${DESKTOP}/local-agent-mode-sessions/acct/org`;

function cowork(overrides: Partial<CoworkSession> = {}): CoworkSession {
  return {
    id: 'local_c',
    cliSessionId: null,
    processName: null,
    cwd: '/sessions/vm-name',
    title: 'Plan a trip',
    createdAt: 1,
    lastActivityAt: 9,
    archived: false,
    model: null,
    initialMessage: null,
    auditPath: '/a',
    outputsDir: '/o',
    filePath: '/f',
    ...overrides,
  };
}

describe('coworkRoot', () => {
  it('is under the Desktop dir, and null on Linux', async () => {
    const mac = await makeScratchHome('darwin');
    expect(coworkRoot(mac.paths)).toBe(path.join(mac.root, DESKTOP, 'local-agent-mode-sessions'));
    const linux = await makeScratchHome('linux');
    expect(coworkRoot(linux.paths)).toBeNull();
    await mac.cleanup();
    await linux.cleanup();
  });
});

describe('readCoworkSessions', () => {
  it('is empty on Linux', async () => {
    const home = await makeScratchHome('linux');
    await expect(readCoworkSessions(home.paths)).resolves.toStrictEqual({ items: [], errors: [] });
    await home.cleanup();
  });

  it('reads known fields, leaves out private ones, and points at the sibling dir', async () => {
    const home = await makeScratchHome();
    const file = await home.writeJson(`${DIR}/local_abc.json`, {
      sessionId: 'local_abc',
      processName: 'happy-otter',
      cliSessionId: 'cli-abc',
      cwd: '/sessions/happy-otter',
      createdAt: 10,
      lastActivityAt: 20,
      model: 'claude-opus-5',
      isArchived: true,
      title: 'Sort photos',
      initialMessage: 'hello',
      systemPrompt: 'private',
      emailAddress: 'someone@example.com',
      accountName: 'Someone',
    });
    await home.writeJson(`${DIR}/scheduled-tasks.json`, []);
    const sessionDir = path.join(path.dirname(file), 'local_abc');
    const result = await readCoworkSessions(home.paths);
    expect(result.errors).toStrictEqual([]);
    expect(result.items).toStrictEqual([
      {
        id: 'local_abc',
        cliSessionId: 'cli-abc',
        processName: 'happy-otter',
        cwd: '/sessions/happy-otter',
        title: 'Sort photos',
        createdAt: 10,
        lastActivityAt: 20,
        archived: true,
        model: 'claude-opus-5',
        initialMessage: 'hello',
        auditPath: path.join(sessionDir, 'audit.jsonl'),
        outputsDir: path.join(sessionDir, 'outputs'),
        filePath: file,
      },
    ]);
    await home.cleanup();
  });

  it('fills defaults and reports bad files', async () => {
    const home = await makeScratchHome();
    await home.writeJson(`${DIR}/local_min.json`, { sessionId: 'local_min', createdAt: 5 });
    const bad = await home.writeJson(`${DIR}/local_zz.json`, { createdAt: 5 });
    const result = await readCoworkSessions(home.paths);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'local_min',
      cliSessionId: null,
      processName: null,
      cwd: null,
      title: null,
      lastActivityAt: 5,
      archived: false,
      model: null,
      initialMessage: null,
    });
    expect(result.errors.map((error) => [error.source, error.path])).toStrictEqual([
      ['cowork', bad],
    ]);
    await home.cleanup();
  });
});

describe('coworkToSurface', () => {
  it('builds a Cowork row that can open in Desktop', () => {
    expect(coworkToSurface(cowork({ archived: true }))).toStrictEqual({
      id: 'local_c',
      surface: 'cowork',
      title: 'Plan a trip',
      cwd: '/sessions/vm-name',
      updatedAt: 9,
      archived: true,
      handoffs: ['open-desktop'],
    });
  });

  it('labels untitled sessions without using the VM cwd', () => {
    expect(coworkToSurface(cowork({ title: '  ' })).title).toBe('Cowork session');
  });
});
