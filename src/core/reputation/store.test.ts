import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';

import type { Prompt } from './prompts.js';
import type { ReputationIndex } from './store.js';
import {
  addHistoryPrompt,
  addPrompt,
  claimSession,
  emptyIndex,
  loadIndex,
  saveIndex,
} from './store.js';

async function indexFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-reputation-store-'));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'nested', 'frustration.json');
}

function prompt(id: string, text: string, sessionId = 's1'): Prompt {
  return { id, sessionId, at: 1000, text };
}

function filled(): ReputationIndex {
  const index = emptyIndex();
  index.files.set('/p/s1.jsonl', { mtimeMs: 5, size: 10 });
  index.sessions.set('s1', { source: 'transcript', title: 'Fix the build' });
  addPrompt(index, prompt('t:a', 'you idiot'));
  addPrompt(index, prompt('t:b', 'fine'));
  addPrompt(index, prompt('t:c', 'thanks, great job'));
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
      version: 2,
      scannedAt: 77,
      hits: { 't:a': { terms: ['idiot'], target: 'agent', excerpt: 'you idiot' } },
      kind: { 't:c': { terms: ['thanks', 'great job'], excerpt: 'thanks, great job' } },
    });
  });

  it('keeps the counts from a Frustration index and reads every file again', async () => {
    const file = await indexFile();
    const old = filled();
    await saveIndex(file, old);
    const saved = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, 'utf8')));
    const v1 = Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'kind'));
    await writeFile(file, JSON.stringify({ ...v1, version: 1 }));
    const { index } = await loadIndex(file, 1);
    expect(index.files.size).toBe(0);
    expect(index.kind.size).toBe(0);
    expect(index.prompts).toStrictEqual(old.prompts);
    expect(index.hits).toStrictEqual(old.hits);
    expect(index.sessions).toStrictEqual(old.sessions);
  });

  it('reads a hit saved as aimed at claude as aimed at the agent', async () => {
    const file = await indexFile();
    await saveIndex(file, filled());
    const saved = await readFile(file, 'utf8');
    await writeFile(file, saved.replaceAll('"target":"agent"', '"target":"claude"'));
    const { index, backup } = await loadIndex(file, 1);
    expect(backup).toBeNull();
    expect(index.hits.get('t:a')?.target).toBe('agent');
  });

  it('backs up a corrupt or unexpected file and starts over', async () => {
    const file = await indexFile();
    await saveIndex(file, emptyIndex());
    const cases: readonly (readonly [number, string])[] = [
      [5, '{not json'],
      [6, JSON.stringify({ version: 2 })],
      [7, JSON.stringify({ version: 3 })],
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
    expect(index.kind.size).toBe(0);
  });

  it('finds kind words and checks a known prompt again when it is read again', () => {
    const index = emptyIndex();
    expect(addPrompt(index, prompt('t:a', 'please fix this damn test, thanks'))).toBe(true);
    expect(index.kind.get('t:a')?.terms).toStrictEqual(['please', 'thanks']);
    expect(index.hits.get('t:a')?.terms).toStrictEqual(['damn']);
    index.kind.delete('t:a');
    index.hits.set('t:b', { terms: ['old'], target: 'agent', excerpt: 'old' });
    expect(addPrompt(index, prompt('t:a', 'please fix this damn test, thanks'))).toBe(false);
    expect(index.kind.get('t:a')?.terms).toStrictEqual(['please', 'thanks']);
    expect(addPrompt(index, prompt('t:b', 'fine'))).toBe(true);
    expect(index.hits.has('t:b')).toBe(false);
  });
});

describe('claimSession', () => {
  it('drops history prompts for that session only and keeps the title', () => {
    const index = emptyIndex();
    addHistoryPrompt(index, prompt('h:1', 'you idiot'));
    addHistoryPrompt(index, prompt('h:2', 'shit', 's2'));
    addHistoryPrompt(index, prompt('h:3', 'thanks'));
    index.sessions.set('s1', { source: 'history', title: 'Old' });
    addPrompt(index, prompt('t:keep', 'damn'));
    claimSession(index, 's1', null);
    expect([...index.prompts.keys()]).toStrictEqual(['h:2', 't:keep']);
    expect([...index.hits.keys()]).toStrictEqual(['h:2', 't:keep']);
    expect(index.kind.size).toBe(0);
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
