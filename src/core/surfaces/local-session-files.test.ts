import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isSessionFileName, listSessionFiles, readSessionFiles } from './local-session-files.js';
import { makeScratchHome } from './test-helpers/scratch-home.js';

describe('isSessionFileName', () => {
  it('accepts local_<id>.json only', () => {
    expect(isSessionFileName('local_abc-123.json')).toBe(true);
    expect(isSessionFileName('local_x.json')).toBe(true);
    expect(isSessionFileName('local_.json')).toBe(false);
    expect(isSessionFileName('scheduled-tasks.json')).toBe(false);
    expect(isSessionFileName('prefix-local_a.json')).toBe(false);
    expect(isSessionFileName('local_a.json.bak')).toBe(false);
    expect(isSessionFileName('local_a.jsonl')).toBe(false);
    expect(isSessionFileName('local_a')).toBe(false);
  });
});

describe('listSessionFiles', () => {
  it('returns nothing for a missing root', async () => {
    const home = await makeScratchHome();
    await expect(listSessionFiles(path.join(home.root, 'none'))).resolves.toStrictEqual([]);
    await home.cleanup();
  });

  it('finds session files two levels down, sorted, and nothing else', async () => {
    const home = await makeScratchHome();
    const a = await home.writeJson('r/acct1/org1/local_b.json', {});
    const b = await home.writeJson('r/acct1/org1/local_a.json', {});
    const c = await home.writeJson('r/acct2/org9/local_c.json', {});
    await home.writeJson('r/acct1/org1/scheduled-tasks.json', {});
    await home.writeJson('r/acct1/local_top.json', {});
    await home.writeJson('r/local_root.json', {});
    await home.makeDir('r/acct1/org1/local_dir.json');
    await home.writeJson('r/acct1/org1/local_a/audit.json', {});
    await home.writeJson('r/acct1/org1/deeper/local_deep.json', {});
    await home.writeText('r/file-not-dir', 'x');
    await expect(listSessionFiles(path.join(home.root, 'r'))).resolves.toStrictEqual([b, a, c]);
    await home.cleanup();
  });
});

describe('readSessionFiles', () => {
  const schema = z.object({ n: z.number() });

  it('parses each file and reports the bad ones with their paths', async () => {
    const home = await makeScratchHome();
    const good = await home.writeJson('r/a/o/local_1.json', { n: 1 });
    const broken = await home.writeText('r/a/o/local_2.json', '{');
    const wrong = await home.writeJson('r/a/o/local_3.json', { n: 'x' });
    const result = await readSessionFiles(path.join(home.root, 'r'), schema, 'desk');
    expect(result.items).toStrictEqual([{ filePath: good, data: { n: 1 } }]);
    expect(result.errors.map((error) => [error.source, error.path])).toStrictEqual([
      ['desk', broken],
      ['desk', wrong],
    ]);
    await home.cleanup();
  });

  it('reports a root it cannot list', async () => {
    const home = await makeScratchHome();
    const root = await home.writeText('r', 'not a dir');
    const result = await readSessionFiles(root, schema, 'cowork');
    expect(result.items).toStrictEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.source).toBe('cowork');
    expect(result.errors[0]?.path).toBe(root);
    expect(result.errors[0]?.message).toMatch(/ENOTDIR/u);
    await home.cleanup();
  });
});
