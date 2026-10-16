import { lstat, readFile, readlink, stat, symlink, utimes } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  copyPath,
  hashPath,
  hashText,
  isInside,
  listDir,
  listFilesRecursive,
  lstatOrNull,
  pathExists,
  readJsonOrUndefined,
  readTextOrNull,
  realpathOrSelf,
  statOrNull,
} from './files.js';
import { scratchDir, writeTree } from './test-helpers/fixtures.js';

describe('missing paths read as null', () => {
  it('covers stat, read and realpath', async () => {
    const dir = await scratchDir();
    const missing = path.join(dir, 'missing');
    expect(await lstatOrNull(missing)).toBeNull();
    expect(await statOrNull(missing)).toBeNull();
    expect(await pathExists(missing)).toBe(false);
    expect(await readTextOrNull(missing)).toBeNull();
    expect(await readJsonOrUndefined(missing)).toBeUndefined();
    expect(await realpathOrSelf(path.join(dir, 'a', '..', 'missing'))).toBe(missing);
  });

  it('reads what is there', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'a.json': '{"x":1}', 'bad.json': '{' });
    expect(await pathExists(path.join(dir, 'a.json'))).toBe(true);
    expect(await readTextOrNull(path.join(dir, 'a.json'))).toBe('{"x":1}');
    expect(await readJsonOrUndefined(path.join(dir, 'a.json'))).toStrictEqual({ x: 1 });
    expect(await readJsonOrUndefined(path.join(dir, 'bad.json'))).toBeUndefined();
    const info = await statOrNull(dir);
    const linkInfo = await lstatOrNull(dir);
    expect(info?.isDirectory()).toBe(true);
    expect(linkInfo?.isDirectory()).toBe(true);
  });

  it('resolves symlinks, and a dangling link counts as existing', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'real.txt': 'r' });
    await symlink(path.join(dir, 'real.txt'), path.join(dir, 'link'));
    await symlink(path.join(dir, 'gone'), path.join(dir, 'dangling'));
    expect(await realpathOrSelf(path.join(dir, 'link'))).toBe(path.join(dir, 'real.txt'));
    expect(await pathExists(path.join(dir, 'dangling'))).toBe(true);
  });
});

describe('isInside', () => {
  it('handles equal, nested, sibling and dotted names', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
    expect(isInside('/a/b/..c', '/a/b')).toBe(true);
    expect(isInside('/x/y', '/a')).toBe(false);
  });
});

describe('listing', () => {
  it('lists sorted entries with link and folder flags', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'b.txt': 'b', 'a/x.md': 'x' });
    await symlink(path.join(dir, 'a'), path.join(dir, 'c'));
    expect(await listDir(dir)).toStrictEqual([
      { name: 'a', path: path.join(dir, 'a'), isDirectory: true, isSymlink: false },
      { name: 'b.txt', path: path.join(dir, 'b.txt'), isDirectory: false, isSymlink: false },
      { name: 'c', path: path.join(dir, 'c'), isDirectory: true, isSymlink: true },
    ]);
    expect(await listDir(path.join(dir, 'missing'))).toStrictEqual([]);
  });

  it('walks files recursively, following links', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'z.md': 'z', 'a/b/c.md': 'c', 'a/d.md': 'd' });
    await symlink(path.join(dir, 'a', 'b'), path.join(dir, 'l'));
    expect(await listFilesRecursive(dir)).toStrictEqual(['a/b/c.md', 'a/d.md', 'l/c.md', 'z.md']);
  });
});

describe('hashing', () => {
  it('hashes text, files and trees', async () => {
    expect(hashText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const one = await scratchDir();
    const two = await scratchDir();
    await writeTree(one, { 'a.md': 'a', 'b/c.md': 'c' });
    await writeTree(two, { 'a.md': 'a', 'b/c.md': 'c' });
    expect(await hashPath(path.join(one, 'a.md'))).toBe(hashText('a'));
    expect(await hashPath(one)).toBe(await hashPath(two));
    expect(await hashPath(one)).toBe(hashText(`a.md\0${hashText('a')}\nb/c.md\0${hashText('c')}`));
    await writeTree(two, { 'b/c.md': 'changed' });
    expect(await hashPath(one)).not.toBe(await hashPath(two));
    await writeTree(two, { 'b/c.md': 'c', 'b/extra.md': '' });
    expect(await hashPath(one)).not.toBe(await hashPath(two));
    expect(await hashPath(path.join(one, 'missing'))).toBeNull();
  });
});

describe('copyPath', () => {
  it('copies trees, keeps links as links and keeps times', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'src/a.md': 'a', 'src/sub/b.md': 'b' });
    await symlink('a.md', path.join(dir, 'src', 'link'));
    const when = new Date('2020-01-02T03:04:05Z');
    await utimes(path.join(dir, 'src', 'a.md'), when, when);
    await copyPath(path.join(dir, 'src'), path.join(dir, 'out'));
    expect(await readFile(path.join(dir, 'out', 'a.md'), 'utf8')).toBe('a');
    expect(await readFile(path.join(dir, 'out', 'sub', 'b.md'), 'utf8')).toBe('b');
    expect(await readlink(path.join(dir, 'out', 'link'))).toBe('a.md');
    const copied = await stat(path.join(dir, 'out', 'a.md'));
    expect(copied.mtimeMs).toBe(when.getTime());
  });

  it('replaces an existing link target and overwrites files', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'a.md': 'new', 'b.md': 'old' });
    await symlink('x', path.join(dir, 'link'));
    await symlink('y', path.join(dir, 'copy'));
    await copyPath(path.join(dir, 'link'), path.join(dir, 'copy'));
    expect(await readlink(path.join(dir, 'copy'))).toBe('x');
    const copy = await lstat(path.join(dir, 'copy'));
    expect(copy.isSymbolicLink()).toBe(true);
    await copyPath(path.join(dir, 'a.md'), path.join(dir, 'b.md'));
    expect(await readFile(path.join(dir, 'b.md'), 'utf8')).toBe('new');
  });
});
