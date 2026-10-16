import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { Prompt } from './prompts.js';
import type { FrustrationIndex } from './store.js';
import {
  addHistoryPrompt,
  addPrompt,
  claimSession,
  emptyIndex,
  loadIndex,
  saveIndex,
} from './store.js';

async function indexFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-frustration-store-'));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'nested', 'frustration.json');
}

function prompt(id: string, text: string, sessionId = 's1'): Prompt {
  return { id, sessionId, at: 1000, text };
}

function filled(): FrustrationIndex {
  const index = emptyIndex();
  index.files.set('/p/s1.jsonl', { mtimeMs: 5, size: 10 });
  index.sessions.set('s1', { source: 'transcript', title: 'Fix the build' });
  addPrompt(index, prompt('t:a', 'you idiot'));
  addPrompt(index, prompt('t:b', 'fine'));
  index.scannedAt = 77;
  return index;
}

describe('index file', () => {
  it('starts empty without a file', async () => {
    const file = await indexFile();
    expect(await loadIndex(file, 1)).toStrictEqual({ index: emptyIndex(), backup: null });
  });

  it('round trips through the file', async () => {
    const file = await indexFile();
    const index = filled();
    await saveIndex(file, index);
    expect(await loadIndex(file, 1)).toStrictEqual({ index, backup: null });
    const text = await readFile(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      scannedAt: 77,
      hits: { 't:a': { terms: ['idiot'], target: 'claude', excerpt: 'you idiot' } },
    });
  });

  it('backs up a corrupt or unexpected file and starts over', async () => {
    const file = await indexFile();
    await saveIndex(file, emptyIndex());
    const cases: readonly (readonly [number, string])[] = [
      [5, '{not json'],
      [6, JSON.stringify({ version: 2 })],
    ];
    for (const [now, text] of cases) {
      await writeFile(file, text);
      const loaded = await loadIndex(file, now);
      expect(loaded).toStrictEqual({
        index: emptyIndex(),
        backup: `${file}.corrupt-${String(now)}`,
      });
      expect(await readFile(`${file}.corrupt-${String(now)}`, 'utf8')).toBe(text);
    }
  });
});

describe('addPrompt', () => {
  it('counts a prompt once and keeps a hit only when there is one', () => {
    const index = emptyIndex();
    expect(addPrompt(index, prompt('t:a', 'this is shit'))).toBe(true);
    expect(addPrompt(index, prompt('t:a', 'this is shit'))).toBe(false);
    expect(addPrompt(index, prompt('t:b', 'fine'))).toBe(true);
    expect([...index.prompts]).toStrictEqual([
      ['t:a', { sessionId: 's1', at: 1000 }],
      ['t:b', { sessionId: 's1', at: 1000 }],
    ]);
    expect([...index.hits]).toStrictEqual([
      ['t:a', { terms: ['shit'], target: 'general', excerpt: 'this is shit' }],
    ]);
  });
});

describe('claimSession', () => {
  it('drops history prompts for that session only and keeps the title', () => {
    const index = emptyIndex();
    addHistoryPrompt(index, prompt('h:1', 'you idiot'));
    addHistoryPrompt(index, prompt('h:2', 'shit', 's2'));
    index.sessions.set('s1', { source: 'history', title: 'Old' });
    addPrompt(index, prompt('t:keep', 'damn'));
    claimSession(index, 's1', null);
    expect([...index.prompts.keys()]).toStrictEqual(['h:2', 't:keep']);
    expect([...index.hits.keys()]).toStrictEqual(['h:2', 't:keep']);
    expect(index.sessions.get('s1')).toStrictEqual({ source: 'transcript', title: 'Old' });
    claimSession(index, 's1', 'New');
    expect(index.sessions.get('s1')).toStrictEqual({ source: 'transcript', title: 'New' });
  });

  it('leaves transcript prompts alone and starts new sessions with no title', () => {
    const index = emptyIndex();
    index.sessions.set('s1', { source: 'transcript', title: null });
    index.prompts.set('h:odd', { sessionId: 's1', at: 1 });
    claimSession(index, 's1', null);
    claimSession(index, 's3', null);
    expect([...index.prompts.keys()]).toStrictEqual(['h:odd']);
    expect(index.sessions.get('s3')).toStrictEqual({ source: 'transcript', title: null });
  });
});

describe('addHistoryPrompt', () => {
  it('skips sessions read from transcripts and records the rest as history', () => {
    const index = emptyIndex();
    claimSession(index, 's1', 'T');
    expect(addHistoryPrompt(index, prompt('h:1', 'x'))).toBe(false);
    expect(index.prompts.size).toBe(0);
    index.sessions.set('s2', { source: 'history', title: 'Kept' });
    expect(addHistoryPrompt(index, prompt('h:2', 'x', 's2'))).toBe(true);
    expect(addHistoryPrompt(index, prompt('h:2', 'x', 's2'))).toBe(false);
    expect(addHistoryPrompt(index, prompt('h:3', 'x', 's3'))).toBe(true);
    expect(index.sessions.get('s2')).toStrictEqual({ source: 'history', title: 'Kept' });
    expect(index.sessions.get('s3')).toStrictEqual({ source: 'history', title: null });
  });
});
