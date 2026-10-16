import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JsonValue } from './json.js';
import { formatSettings, setKeyPath, writeSetting } from './write.js';

async function names(folder: string): Promise<readonly string[]> {
  const entries = await readdir(folder);
  return entries.toSorted((left, right) => left.localeCompare(right));
}

async function isLink(file: string): Promise<boolean> {
  const info = await lstat(file);
  return info.isSymbolicLink();
}

describe('write', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-knobs-write-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function file(name = 'settings.json'): string {
    return path.join(dir, name);
  }

  describe('formatSettings', () => {
    it('uses 2-space indent and a trailing newline', () => {
      expect(formatSettings({ a: { b: [1] } })).toBe(
        '{\n  "a": {\n    "b": [\n      1\n    ]\n  }\n}\n',
      );
      expect(formatSettings({})).toBe('{}\n');
    });
  });

  describe('setKeyPath', () => {
    it('sets, replaces and deletes nested keys without mutating the input', () => {
      const input = { a: 1, b: { c: 2, d: 3 } };
      expect(setKeyPath(input, ['b', 'c'], 9)).toStrictEqual({
        ok: true,
        value: { a: 1, b: { c: 9, d: 3 } },
      });
      expect(setKeyPath(input, ['b', 'c'], undefined)).toStrictEqual({
        ok: true,
        value: { a: 1, b: { d: 3 } },
      });
      expect(setKeyPath(input, ['x', 'y'], true)).toStrictEqual({
        ok: true,
        value: { a: 1, b: { c: 2, d: 3 }, x: { y: true } },
      });
      expect(setKeyPath(input, ['x', 'y'], undefined)).toStrictEqual({ ok: true, value: input });
      expect(input).toStrictEqual({ a: 1, b: { c: 2, d: 3 } });
    });

    it('refuses an empty path and a path through a non-object', () => {
      expect(setKeyPath({}, [], 1)).toStrictEqual({ ok: false, error: 'The key path is empty.' });
      expect(setKeyPath({ a: [1] }, ['a', 'b'], 1)).toStrictEqual({
        ok: false,
        error: 'a holds a list, not an object.',
      });
      expect(setKeyPath({ a: { b: 'x' } }, ['a', 'b', 'c'], 1)).toStrictEqual({
        ok: false,
        error: 'b holds a string, not an object.',
      });
      expect(setKeyPath({ a: 5 }, ['a', 'b'], 1)).toStrictEqual({
        ok: false,
        error: 'a holds a number, not an object.',
      });
      expect(setKeyPath({ a: null }, ['a', 'b'], 1)).toStrictEqual({
        ok: true,
        value: { a: { b: 1 } },
      });
    });

    it('never touches a prototype', () => {
      const result = setKeyPath({}, ['__proto__', 'polluted'], 'yes');
      expect(result.ok).toBe(true);
      expect(Object.hasOwn(result.ok ? result.value : {}, '__proto__')).toBe(true);
      const fresh: Record<string, unknown> = {};
      expect(fresh['polluted']).toBeUndefined();
      expect('polluted' in fresh).toBe(false);
      const inherited = setKeyPath({}, ['toString', 'x'], 1);
      expect(inherited).toStrictEqual({ ok: true, value: { toString: { x: 1 } } });
    });
  });

  describe('writeSetting', () => {
    it('creates a missing file with the nested key', async () => {
      const target = file();
      const result = await writeSetting({
        file: target,
        keyPath: 'permissions.defaultMode',
        value: 'plan',
      });
      expect(result).toStrictEqual({ ok: true, file: target, changed: true, backup: null });
      expect(await readFile(target, 'utf8')).toBe(
        '{\n  "permissions": {\n    "defaultMode": "plan"\n  }\n}\n',
      );
    });

    it('keeps other keys and their order and backs up the old file', async () => {
      const target = file();
      const before = '{"z":1,"model":"opus","a":{"x":true}}';
      await writeFile(target, before);
      const result = await writeSetting({ file: target, keyPath: 'model', value: 'haiku' });
      expect(result).toStrictEqual({
        ok: true,
        file: target,
        changed: true,
        backup: `${target}.bak`,
      });
      expect(await readFile(target, 'utf8')).toBe(
        '{\n  "z": 1,\n  "model": "haiku",\n  "a": {\n    "x": true\n  }\n}\n',
      );
      expect(await readFile(`${target}.bak`, 'utf8')).toBe(before);
      await writeSetting({ file: target, keyPath: 'a.y', value: [1, 2] });
      expect(JSON.parse(await readFile(target, 'utf8'))).toStrictEqual({
        z: 1,
        model: 'haiku',
        a: { x: true, y: [1, 2] },
      });
    });

    it('deletes a key', async () => {
      const target = file();
      await writeFile(target, '{"a":1,"b":2}\n');
      const result = await writeSetting({ file: target, keyPath: 'a', value: undefined });
      expect(result).toMatchObject({ ok: true, changed: true });
      expect(await readFile(target, 'utf8')).toBe('{\n  "b": 2\n}\n');
    });

    it('reports no change and writes nothing when the content would not change', async () => {
      const target = file();
      await writeFile(target, '{\n  "a": 1\n}\n');
      expect(await writeSetting({ file: target, keyPath: 'a', value: 1 })).toStrictEqual({
        ok: true,
        file: target,
        changed: false,
        backup: null,
      });
      expect(await writeSetting({ file: target, keyPath: 'x.y', value: undefined })).toMatchObject({
        changed: false,
      });
      expect(await readdir(dir)).toStrictEqual(['settings.json']);
      const missing = file('missing.json');
      expect(await writeSetting({ file: missing, keyPath: 'a', value: undefined })).toStrictEqual({
        ok: true,
        file: missing,
        changed: false,
        backup: null,
      });
      expect(await readdir(dir)).toStrictEqual(['settings.json']);
    });

    it('rewrites a file whose formatting differs even when the value is the same', async () => {
      const target = file();
      await writeFile(target, '{"a":1}');
      expect(await writeSetting({ file: target, keyPath: 'a', value: 1 })).toMatchObject({
        changed: true,
      });
      expect(await readFile(target, 'utf8')).toBe('{\n  "a": 1\n}\n');
    });

    it('treats an empty file as an empty object', async () => {
      const target = file();
      await writeFile(target, '  \n');
      await writeSetting({ file: target, keyPath: 'a', value: 1 });
      expect(await readFile(target, 'utf8')).toBe('{\n  "a": 1\n}\n');
      expect(await readFile(`${target}.bak`, 'utf8')).toBe('  \n');
    });

    it('refuses to touch a file that is not valid JSON or not an object', async () => {
      const target = file();
      await writeFile(target, '{"a": 1,}');
      const bad = await writeSetting({ file: target, keyPath: 'a', value: 2 });
      expect(bad.ok).toBe(false);
      expect(bad.ok ? '' : bad.error).toMatch(
        /^.+ is not valid JSON \(.+\), so it was left alone\.$/u,
      );
      expect(await readFile(target, 'utf8')).toBe('{"a": 1,}');
      await writeFile(target, '[1]');
      expect(await writeSetting({ file: target, keyPath: 'a', value: 2 })).toStrictEqual({
        ok: false,
        error: `${target} does not hold a JSON object, so it was left alone.`,
      });
      expect(await readdir(dir)).toStrictEqual(['settings.json']);
    });

    it('refuses bad key paths and paths through non-objects', async () => {
      const target = file();
      await writeFile(target, '{"a":"text"}');
      for (const keyPath of ['', 'a..b', '.a', 'a.']) {
        expect(await writeSetting({ file: target, keyPath, value: 1 })).toStrictEqual({
          ok: false,
          error: `Invalid key path "${keyPath}".`,
        });
      }
      expect(await writeSetting({ file: target, keyPath: 'a.b', value: 1 })).toStrictEqual({
        ok: false,
        error: 'Cannot set a.b: a holds a string, not an object.',
      });
      expect(await readFile(target, 'utf8')).toBe('{"a":"text"}');
    });

    it('writes through a symlink and leaves the link in place', async () => {
      const real = path.join(dir, 'dotfiles', 'settings.json');
      await mkdir(path.dirname(real));
      await writeFile(real, '{"keep":1}');
      const link = path.join(dir, 'home-settings.json');
      await symlink(real, link);
      const result = await writeSetting({ file: link, keyPath: 'model', value: 'opus' });
      expect(result).toStrictEqual({ ok: true, file: real, changed: true, backup: `${real}.bak` });
      expect(await isLink(link)).toBe(true);
      expect(await readFile(link, 'utf8')).toBe('{\n  "keep": 1,\n  "model": "opus"\n}\n');
      expect(await readFile(`${real}.bak`, 'utf8')).toBe('{"keep":1}');
      expect(await names(dir)).toStrictEqual(['dotfiles', 'home-settings.json']);
    });

    it('creates the target of a dangling symlink', async () => {
      const real = path.join(dir, 'dotfiles', 'new.json');
      await mkdir(path.dirname(real));
      const link = path.join(dir, 'link.json');
      await symlink(real, link);
      await writeSetting({ file: link, keyPath: 'a', value: 1 });
      expect(await isLink(link)).toBe(true);
      expect(await readFile(real, 'utf8')).toBe('{\n  "a": 1\n}\n');
    });

    it('reports a write it cannot make', async () => {
      await writeFile(file('plain'), 'x');
      const target = path.join(dir, 'plain', 'settings.json');
      const result = await writeSetting({ file: target, keyPath: 'a', value: 1 });
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error).toContain(`Cannot write ${target}: `);
      expect(result.ok ? '' : result.error).toContain('ENOTDIR');
    });

    it('round-trips any value and leaves other keys untouched (property)', async () => {
      let counter = 0;
      const key = fc.string({ minLength: 1, maxLength: 8 }).filter((name) => !name.includes('.'));
      await fc.assert(
        fc.asyncProperty(
          fc.dictionary(key, fc.jsonValue({ maxDepth: 2 }), { maxKeys: 5 }),
          key,
          fc.jsonValue({ maxDepth: 2 }),
          async (base, name, value: JsonValue) => {
            counter += 1;
            const target = file(`prop-${String(counter)}.json`);
            await writeFile(target, JSON.stringify(base));
            const result = await writeSetting({ file: target, keyPath: name, value });
            expect(result.ok).toBe(true);
            const reread: unknown = JSON.parse(await readFile(target, 'utf8'));
            const expected: [string, unknown][] = Object.hasOwn(base, name)
              ? Object.entries(base).map(([k, v]) => [k, k === name ? value : v])
              : [...Object.entries(base), [name, value]];
            // JSON has no -0, so compare against the expected object after a JSON round trip.
            const normalized: unknown = JSON.parse(formatSettings(Object.fromEntries(expected)));
            expect(Object.entries(reread ?? {})).toStrictEqual(Object.entries(normalized ?? {}));
          },
        ),
        { numRuns: 60 },
      );
    });
  });
});
