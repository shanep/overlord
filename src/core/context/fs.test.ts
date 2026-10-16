import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { byCodePoint, createNodeFileSystem, exists } from './fs.js';

describe('createNodeFileSystem', () => {
  let root = '';
  const fs = createNodeFileSystem();

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'overlord-fs-'));
    await mkdir(path.join(root, 'dir'));
    await writeFile(path.join(root, 'b.md'), 'bee');
    await writeFile(path.join(root, 'a.md'), 'ay');
    await writeFile(path.join(root, 'C.md'), 'sea');
    await symlink(path.join(root, 'a.md'), path.join(root, 'link.md'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports files, directories, other kinds and missing paths', async () => {
    expect(await fs.kind(path.join(root, 'a.md'))).toBe('file');
    expect(await fs.kind(path.join(root, 'dir'))).toBe('directory');
    expect(await fs.kind('/dev/null')).toBe('other');
    expect(await fs.kind(path.join(root, 'nope'))).toBeNull();
    expect(await fs.kind(path.join(root, 'link.md'))).toBe('file');
  });

  it('reads text and returns null when it cannot', async () => {
    expect(await fs.readFile(path.join(root, 'a.md'))).toBe('ay');
    expect(await fs.readFile(path.join(root, 'nope'))).toBeNull();
    expect(await fs.readFile(path.join(root, 'dir'))).toBeNull();
  });

  it('lists names sorted by code point and an empty list for a missing dir', async () => {
    expect(await fs.readdir(root)).toStrictEqual(['C.md', 'a.md', 'b.md', 'dir', 'link.md']);
    expect(await fs.readdir(path.join(root, 'nope'))).toStrictEqual([]);
  });

  it('resolves symlinks and returns null for missing paths', async () => {
    const real = await fs.realpath(path.join(root, 'link.md'));
    expect(real).toBe(await fs.realpath(path.join(root, 'a.md')));
    expect(real?.endsWith('a.md')).toBe(true);
    expect(await fs.realpath(path.join(root, 'nope'))).toBeNull();
  });

  it('answers exists from kind', async () => {
    expect(await exists(fs, path.join(root, 'dir'))).toBe(true);
    expect(await exists(fs, path.join(root, 'nope'))).toBe(false);
  });
});

describe('byCodePoint', () => {
  it('orders by code point and keeps equal strings equal', () => {
    expect(byCodePoint('a', 'b')).toBe(-1);
    expect(byCodePoint('b', 'a')).toBe(1);
    expect(byCodePoint('B', 'a')).toBe(-1);
    expect(byCodePoint('same', 'same')).toBe(0);
  });
});
