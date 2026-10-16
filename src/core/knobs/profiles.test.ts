import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LaunchProfile } from '../../shared/model.js';

import {
  deleteProfile,
  listProfiles,
  saveProfile,
  toExtraArgs,
  toLaunchOptions,
} from './profiles.js';

function profile(id: string, partial: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id,
    name: `Profile ${id}`,
    model: null,
    effort: null,
    permissionMode: null,
    env: {},
    extraArgs: [],
    ...partial,
  };
}

describe('profiles', () => {
  let dir: string;
  let store: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-knobs-profiles-'));
    store = path.join(dir, 'global-storage', 'profiles.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('listProfiles', () => {
    it('is empty with no error when the store does not exist', async () => {
      expect(await listProfiles(store)).toStrictEqual({ profiles: [], error: null });
    });

    it('reports invalid JSON, a wrong shape and an unreadable path', async () => {
      await mkdir(path.dirname(store), { recursive: true });
      await writeFile(store, '{nope');
      const invalid = await listProfiles(store);
      expect(invalid.profiles).toStrictEqual([]);
      expect(invalid.error).toContain(`Invalid JSON in ${store}:`);

      await writeFile(store, JSON.stringify({ version: 2, profiles: [] }));
      const shape = await listProfiles(store);
      expect(shape.profiles).toStrictEqual([]);
      expect(shape.error).toContain(`${store} is not a profile store:`);

      const folder = path.join(dir, 'folder');
      await mkdir(folder);
      const unreadable = await listProfiles(folder);
      expect(unreadable.profiles).toStrictEqual([]);
      expect(unreadable.error).toContain(`Cannot read ${folder}: `);
      expect(unreadable.error).toContain('EISDIR');
    });
  });

  describe('saveProfile', () => {
    it('appends new profiles and writes a versioned, formatted store', async () => {
      const first = profile('a', { model: 'opus', env: { DEBUG: '1' }, extraArgs: ['--verbose'] });
      expect(await saveProfile(store, first)).toStrictEqual({ ok: true, profiles: [first] });
      const second = profile('b', { permissionMode: 'plan', effort: 'high' });
      expect(await saveProfile(store, second)).toStrictEqual({
        ok: true,
        profiles: [first, second],
      });
      expect(await listProfiles(store)).toStrictEqual({ profiles: [first, second], error: null });
      expect(await readFile(store, 'utf8')).toBe(
        `${JSON.stringify({ version: 1, profiles: [first, second] }, null, 2)}\n`,
      );
    });

    it('replaces a profile with the same id in place', async () => {
      await saveProfile(store, profile('a'));
      await saveProfile(store, profile('b'));
      const renamed = profile('a', { name: 'Renamed' });
      const result = await saveProfile(store, renamed);
      expect(result).toStrictEqual({ ok: true, profiles: [renamed, profile('b')] });
      expect(await readFile(`${store}.bak`, 'utf8')).toContain('"Profile a"');
    });

    it.each([
      ['an empty id', { ...profile('a'), id: '' }],
      ['an empty name', { ...profile('a'), name: '' }],
      ['an unknown permission mode', { ...profile('a'), permissionMode: 'yolo' }],
      ['a non-string env value', { ...profile('a'), env: { A: 1 } }],
      ['an empty env name', { ...profile('a'), env: { '': 'x' } }],
      ['a non-string extra arg', { ...profile('a'), extraArgs: [1] }],
      ['an empty model', { ...profile('a'), model: '' }],
      ['an empty effort', { ...profile('a'), effort: '' }],
      ['an unknown field', { ...profile('a'), secret: 'x' }],
      ['a non-object', 'profile'],
    ])('rejects %s', async (_label, raw) => {
      const result = await saveProfile(store, raw);
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error).toMatch(/^Invalid profile: /u);
      expect(await listProfiles(store)).toStrictEqual({ profiles: [], error: null });
    });

    it('backs up an unreadable store and starts fresh', async () => {
      await mkdir(path.dirname(store), { recursive: true });
      await writeFile(store, 'corrupt');
      const fresh = profile('a');
      expect(await saveProfile(store, fresh)).toStrictEqual({ ok: true, profiles: [fresh] });
      expect(await readFile(`${store}.bak`, 'utf8')).toBe('corrupt');
    });

    it('reports a store it cannot write', async () => {
      await writeFile(path.join(dir, 'plain'), 'x');
      const blocked = path.join(dir, 'plain', 'profiles.json');
      const result = await saveProfile(blocked, profile('a'));
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error).toContain(`Cannot write ${blocked}: `);
    });
  });

  describe('deleteProfile', () => {
    it('removes the profile with that id and nothing else', async () => {
      await saveProfile(store, profile('a'));
      await saveProfile(store, profile('b'));
      expect(await deleteProfile(store, 'a')).toStrictEqual({ ok: true, profiles: [profile('b')] });
      expect(await deleteProfile(store, 'missing')).toStrictEqual({
        ok: true,
        profiles: [profile('b')],
      });
      const listed = await listProfiles(store);
      expect(listed.profiles).toStrictEqual([profile('b')]);
    });
  });

  describe('toExtraArgs', () => {
    it.each([
      [[], {}],
      [['--verbose'], { verbose: null }],
      [['--max-turns', '5'], { 'max-turns': '5' }],
      [['--debug=api,mcp'], { debug: 'api,mcp' }],
      [['--empty='], { empty: '' }],
      [['--a', '--b', 'x', '--c'], { a: null, b: 'x', c: null }],
      [['--a', '-p', 'stray'], { a: null }],
      [['-w', 'name', '--tmux'], { tmux: null }],
      [['positional', '--', '--x', 'y'], { x: 'y' }],
    ])('turns %j into %j', (args, expected) => {
      expect(toExtraArgs(args)).toStrictEqual(expected);
    });
  });

  describe('toLaunchOptions', () => {
    it('leaves out unset fields', () => {
      const options = toLaunchOptions(profile('a'));
      expect(options).toStrictEqual({ env: {}, extraArgs: {} });
      expect('model' in options).toBe(false);
      expect('effort' in options).toBe(false);
      expect('permissionMode' in options).toBe(false);
    });

    it('copies every set field', () => {
      const env = { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4' };
      const options = toLaunchOptions(
        profile('a', {
          model: 'opus',
          effort: 'xhigh',
          permissionMode: 'acceptEdits',
          env,
          extraArgs: ['--max-turns', '9'],
        }),
      );
      expect(options).toStrictEqual({
        model: 'opus',
        effort: 'xhigh',
        permissionMode: 'acceptEdits',
        env,
        extraArgs: { 'max-turns': '9' },
      });
      expect(options.env).not.toBe(env);
    });
  });
});
