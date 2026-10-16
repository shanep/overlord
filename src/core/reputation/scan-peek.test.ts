import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { scanInto } from './scan.js';
import { emptyIndex } from './store.js';

// A transcript can vanish between the read and the title peek, so the peek fails on its own.
vi.mock(import('../transcripts/peek.js'), () => ({
  peekSession: async (): Promise<never> => {
    await Promise.resolve();
    throw new Error('gone');
  },
}));

describe('scanInto when the title peek fails', () => {
  it('still counts the prompts and leaves the title empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'overlord-reputation-peek-'));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const project = path.join(root, 'projects', '-work');
    await mkdir(project, { recursive: true });
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-10-01T12:00:00.000Z',
      message: { content: 'fine' },
    });
    await writeFile(path.join(project, 's1.jsonl'), `${line}\n`);
    const index = emptyIndex();
    await scanInto(index, {
      projectsDir: path.join(root, 'projects'),
      historyFile: path.join(root, 'history.jsonl'),
      now: 1,
    });
    expect(index.prompts.size).toBe(1);
    expect(index.sessions.get('s1')).toStrictEqual({ source: 'transcript', title: null });
  });
});
