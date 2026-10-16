import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  errorMessage,
  hasErrorCode,
  lenientArray,
  readDirOrEmpty,
  readJsonFile,
  sourceError,
} from './common.js';
import { makeScratchHome } from './test-helpers/scratch-home.js';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('errorMessage', () => {
  it('uses the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything else', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });
});

describe('hasErrorCode', () => {
  it('matches an Error with the same code', () => {
    expect(hasErrorCode(withCode('x', 'ENOENT'), 'ENOENT')).toBe(true);
  });

  it('rejects a different code', () => {
    expect(hasErrorCode(withCode('x', 'EACCES'), 'ENOENT')).toBe(false);
  });

  it('rejects an Error with no code', () => {
    expect(hasErrorCode(new Error('x'), 'ENOENT')).toBe(false);
  });

  it('rejects a plain object that has a code', () => {
    expect(hasErrorCode({ code: 'ENOENT' }, 'ENOENT')).toBe(false);
  });
});

describe('sourceError', () => {
  it('builds a typed error record', () => {
    expect(sourceError('desktop', new Error('bad'), '/a.json')).toStrictEqual({
      source: 'desktop',
      message: 'bad',
      path: '/a.json',
    });
    expect(sourceError('agents', 'oops', null)).toStrictEqual({
      source: 'agents',
      message: 'oops',
      path: null,
    });
  });
});

describe('readJsonFile', () => {
  const schema = z.object({ a: z.number(), b: z.string() });

  it('returns validated data', async () => {
    const home = await makeScratchHome();
    const file = await home.writeJson('x.json', { a: 1, b: 'two', extra: true });
    await expect(readJsonFile(file, schema)).resolves.toStrictEqual({ a: 1, b: 'two' });
    await home.cleanup();
  });

  it('lists every schema issue when the shape is wrong', async () => {
    const home = await makeScratchHome();
    const file = await home.writeJson('x.json', { a: 'one', b: 2 });
    const issues =
      schema.safeParse({ a: 'one', b: 2 }).error?.issues.map((index) => index.message) ?? [];
    expect(issues).toHaveLength(2);
    await expect(readJsonFile(file, schema)).rejects.toThrow(
      new Error(`unexpected shape: ${issues.join('; ')}`),
    );
    await home.cleanup();
  });

  it('rejects text that is not JSON', async () => {
    const home = await makeScratchHome();
    const file = await home.writeText('x.json', '{not json');
    await expect(readJsonFile(file, schema)).rejects.toBeInstanceOf(SyntaxError);
    await home.cleanup();
  });

  it('rejects a missing file with ENOENT', async () => {
    const home = await makeScratchHome();
    const error: unknown = await readJsonFile(`${home.root}/missing.json`, schema).catch(
      (error_: unknown) => error_,
    );
    expect(hasErrorCode(error, 'ENOENT')).toBe(true);
    await home.cleanup();
  });
});

describe('readDirOrEmpty', () => {
  it('returns an empty list for a missing directory', async () => {
    const home = await makeScratchHome();
    await expect(readDirOrEmpty(`${home.root}/nope`)).resolves.toStrictEqual([]);
    await home.cleanup();
  });

  it('lists entries with file types', async () => {
    const home = await makeScratchHome();
    await home.writeText('d/a.txt', 'a');
    await home.makeDir('d/sub');
    const entries = await readDirOrEmpty(`${home.root}/d`);
    const summary = entries
      .map((entry) => `${entry.name}:${entry.isDirectory() ? 'dir' : 'file'}`)
      .toSorted((a, b) => a.localeCompare(b));
    expect(summary).toStrictEqual(['a.txt:file', 'sub:dir']);
    await home.cleanup();
  });

  it('rethrows other errors', async () => {
    const home = await makeScratchHome();
    const file = await home.writeText('f.txt', 'x');
    const error: unknown = await readDirOrEmpty(file).catch((error_: unknown) => error_);
    expect(hasErrorCode(error, 'ENOTDIR')).toBe(true);
    await home.cleanup();
  });
});

describe('lenientArray', () => {
  const schema = lenientArray(z.object({ n: z.number() }));

  it('keeps entries that parse and drops the rest', () => {
    expect(schema.parse([{ n: 1 }, { n: 'x' }, null, { n: 3 }])).toStrictEqual([
      { n: 1 },
      { n: 3 },
    ]);
  });

  it('turns a non-array into an empty list', () => {
    expect(schema.parse('nope')).toStrictEqual([]);
    expect(schema.parse(null)).toStrictEqual([]);
  });
});
