import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PEEK_BYTES, peekSession } from './peek.js';
import { jsonl, makeTemporaryDirectory, removeDir, userPrompt } from './test-helpers/fixtures.js';

async function titleOf(file: string, size: number, bytes?: number): Promise<string | null> {
  const peek = await peekSession(file, size, bytes);
  return peek.title;
}

describe('peekSession', () => {
  let root = '';
  let written = 0;

  beforeEach(async () => {
    root = await makeTemporaryDirectory();
  });

  afterEach(async () => {
    await removeDir(root);
  });

  async function write(records: readonly Readonly<Record<string, unknown>>[]): Promise<{
    readonly file: string;
    readonly size: number;
  }> {
    written += 1;
    const file = path.join(root, `s${String(written)}.jsonl`);
    await writeFile(file, jsonl(records));
    const info = await stat(file);
    return { file, size: info.size };
  }

  it('reads the folder, branch and AI title of a small file', async () => {
    const { file, size } = await write([
      { type: 'last-prompt', lastPrompt: 'first prompt', sessionId: 's' },
      userPrompt('u1', 0, 'hello'),
      { type: 'ai-title', aiTitle: '  Fix the parser  ', sessionId: 's' },
    ]);
    expect(PEEK_BYTES).toBe(65_536);
    expect(await peekSession(file, size)).toStrictEqual({
      cwd: '/work/demo',
      gitBranch: 'main',
      title: 'Fix the parser',
    });
  });

  it('prefers a custom title, then the AI title, then the last prompt', async () => {
    const custom = await write([
      { type: 'custom-title', customTitle: 'Mine' },
      { type: 'ai-title', aiTitle: 'Generated' },
      { type: 'last-prompt', lastPrompt: 'prompt' },
    ]);
    expect(await titleOf(custom.file, custom.size)).toBe('Mine');
    const prompt = await write([
      { type: 'last-prompt', lastPrompt: 'old prompt' },
      { type: 'last-prompt', lastPrompt: 'new\n  prompt' },
      { type: 'last-prompt', lastPrompt: '' },
    ]);
    expect(await peekSession(prompt.file, prompt.size)).toStrictEqual({
      cwd: null,
      gitBranch: null,
      title: 'new prompt',
    });
  });

  it('keeps an earlier title when a later one is blank', async () => {
    const { file, size } = await write([
      { type: 'ai-title', aiTitle: 'Kept' },
      { type: 'ai-title', aiTitle: ' ' },
      { type: 'custom-title', customTitle: 'Named' },
      { type: 'custom-title', customTitle: '' },
    ]);
    expect(await titleOf(file, size)).toBe('Named');
  });

  it('has no title or folder for an empty file and ignores blank cwd values', async () => {
    const empty = await write([]);
    expect(await peekSession(empty.file, empty.size)).toStrictEqual({
      cwd: null,
      gitBranch: null,
      title: null,
    });
    const blank = await write([
      userPrompt('u1', 0, 'x', { cwd: ' ', gitBranch: '' }),
      userPrompt('u2', 1, 'y', { cwd: '/later' }),
    ]);
    const noBranch = await write([
      { type: 'user', cwd: '/x', message: { role: 'user', content: 'a' } },
      { type: 'user', cwd: 7, message: { role: 'user', content: 'b' } },
    ]);
    expect(await peekSession(noBranch.file, noBranch.size)).toStrictEqual({
      cwd: '/x',
      gitBranch: null,
      title: null,
    });
    expect(await peekSession(blank.file, blank.size)).toStrictEqual({
      cwd: '/later',
      gitBranch: 'main',
      title: null,
    });
  });

  it('shortens long titles to 120 characters', async () => {
    const { file, size } = await write([{ type: 'ai-title', aiTitle: 'x'.repeat(200) }]);
    const title = (await titleOf(file, size)) ?? '';
    expect(title).toHaveLength(120);
    expect(title.endsWith('...')).toBe(true);
    const exact = await write([{ type: 'ai-title', aiTitle: 'y'.repeat(120) }]);
    expect(await titleOf(exact.file, exact.size)).toBe('y'.repeat(120));
  });

  it('reads the head and tail of a big file and skips the cut line', async () => {
    const filler = Array.from({ length: 60 }, (_, index) =>
      userPrompt(`f${String(index)}`, index, 'z'.repeat(100), { cwd: '/head' }),
    );
    const { file, size } = await write([
      ...filler,
      { type: 'ai-title', aiTitle: 'Middle' },
      ...filler,
      { type: 'ai-title', aiTitle: 'Tail title' },
    ]);
    const peek = await peekSession(file, size, 2048);
    expect(peek).toStrictEqual({ cwd: '/head', gitBranch: 'main', title: 'Tail title' });
    // Never reads the middle, so the middle title is not seen when the tail has none.
    const noTail = await write([...filler, { type: 'ai-title', aiTitle: 'Middle' }, ...filler]);
    expect(await titleOf(noTail.file, noTail.size, 2048)).toBeNull();
  });

  it('reads the tail from right after the head when the file is under twice the window', async () => {
    const { file, size } = await write([
      userPrompt('u1', 0, 'a'.repeat(300)),
      { type: 'ai-title', aiTitle: 'Near the end' },
    ]);
    expect(await titleOf(file, size, 200)).toBe('Near the end');
  });
});
