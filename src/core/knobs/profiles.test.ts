import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LaunchProfile } from '../../shared/model.js';
import { claudeCode } from '../agents/claude/index.js';

import {
  deleteProfile,
  listProfiles,
  modesLookup,
  saveProfile,
  type AgentModes,
} from './profiles.js';

const CODEX_MODES: AgentModes = {
  permission: [{ id: 'on-request', label: 'On request' }],
  effort: [],
};

/** Claude Code from its adapter, and a stand-in Codex with modes of its own. */
const MODES = modesLookup([claudeCode, { id: 'codex', modes: CODEX_MODES }]);

function profile(id: string, partial: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id,
    agent: 'claude-code',
    name: `Profile ${id}`,
    model: null,
    effort: null,
    permissionMode: null,
    env: {},
    extraArgs: [],
    ...partial,
  };
}

/** What the store file holds: Claude Code profiles leave the agent out. */
function stored(item: LaunchProfile): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'agent'));
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
      expect(await saveProfile(store, first, MODES)).toStrictEqual({ ok: true, profiles: [first] });
      const second = profile('b', { permissionMode: 'plan', effort: 'high' });
      expect(await saveProfile(store, second, MODES)).toStrictEqual({
        ok: true,
        profiles: [first, second],
      });
      expect(await listProfiles(store)).toStrictEqual({ profiles: [first, second], error: null });
      expect(await readFile(store, 'utf8')).toBe(
        `${JSON.stringify({ version: 1, profiles: [first, second].map((item) => stored(item)) }, null, 2)}\n`,
      );
    });

    it('reads a profile saved without an agent as Claude Code', async () => {
      await mkdir(path.dirname(store), { recursive: true });
      const old = stored(profile('a'));
      await writeFile(store, JSON.stringify({ version: 1, profiles: [old] }));
      expect(await listProfiles(store)).toStrictEqual({ profiles: [profile('a')], error: null });
    });

    it('keeps the agent and backend of a profile for another agent', async () => {
      const codex = profile('c', { agent: 'codex', backend: 'boisestate' });
      expect(await saveProfile(store, codex, MODES)).toStrictEqual({ ok: true, profiles: [codex] });
      expect(await listProfiles(store)).toStrictEqual({ profiles: [codex], error: null });
      const file = await readFile(store, 'utf8');
      expect(file).toContain('"agent": "codex"');
      expect(file).toContain('"backend": "boisestate"');
    });

    it('replaces a profile with the same id in place', async () => {
      await saveProfile(store, profile('a'), MODES);
      await saveProfile(store, profile('b'), MODES);
      const renamed = profile('a', { name: 'Renamed' });
      const result = await saveProfile(store, renamed, MODES);
      expect(result).toStrictEqual({ ok: true, profiles: [renamed, profile('b')] });
      expect(await readFile(`${store}.bak`, 'utf8')).toContain('"Profile a"');
    });

    it.each([
      ['an empty id', { ...profile('a'), id: '' }],
      ['an empty name', { ...profile('a'), name: '' }],
      ['an unknown permission mode', { ...profile('a'), permissionMode: 'yolo' }],
      ['an unknown effort level', { ...profile('a'), effort: 'ultra' }],
      ['an effort for an agent with none', { ...profile('a'), agent: 'codex', effort: 'high' }],
      ['a Claude mode on Codex', { ...profile('a'), agent: 'codex', permissionMode: 'plan' }],
      ['an agent Overlord does not know', { ...profile('a'), agent: 'gemini' }],
      ['a non-string env value', { ...profile('a'), env: { A: 1 } }],
      ['an empty env name', { ...profile('a'), env: { '': 'x' } }],
      ['a non-string extra arg', { ...profile('a'), extraArgs: [1] }],
      ['an empty model', { ...profile('a'), model: '' }],
      ['an empty effort', { ...profile('a'), effort: '' }],
      ['an unknown field', { ...profile('a'), secret: 'x' }],
      ['an empty agent', { ...profile('a'), agent: '' }],
      ['an empty backend', { ...profile('a'), backend: '' }],
      ['a non-object', 'profile'],
    ])('rejects %s', async (_label, raw) => {
      const result = await saveProfile(store, raw, MODES);
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error).toMatch(/^Invalid profile: /u);
      expect(await listProfiles(store)).toStrictEqual({ profiles: [], error: null });
    });

    it('names the modes the agent does have', async () => {
      const yolo = await saveProfile(store, profile('a', { permissionMode: 'yolo' }), MODES);
      expect(yolo.ok ? '' : yolo.error).toBe(
        'Invalid profile: "yolo" is not a permission mode of claude-code. Use one of default, acceptEdits, plan, auto, dontAsk, bypassPermissions, manual.',
      );
      const codex = await saveProfile(
        store,
        profile('a', { agent: 'codex', effort: 'high' }),
        MODES,
      );
      expect(codex.ok ? '' : codex.error).toBe(
        'Invalid profile: codex has no effort level to set, so "high" cannot be used.',
      );
      const gemini = await saveProfile(store, profile('a', { agent: 'gemini' }), MODES);
      expect(gemini.ok ? '' : gemini.error).toBe(
        'Invalid profile: Overlord has no agent called gemini.',
      );
    });

    it('still lists a profile saved before modes were checked', async () => {
      await mkdir(path.dirname(store), { recursive: true });
      const old = stored(profile('a', { effort: 'High', permissionMode: 'on-request' }));
      await writeFile(store, JSON.stringify({ version: 1, profiles: [old] }));
      expect(await listProfiles(store)).toStrictEqual({
        profiles: [profile('a', { effort: 'High', permissionMode: 'on-request' })],
        error: null,
      });
    });

    it('backs up an unreadable store and starts fresh', async () => {
      await mkdir(path.dirname(store), { recursive: true });
      await writeFile(store, 'corrupt');
      const fresh = profile('a');
      expect(await saveProfile(store, fresh, MODES)).toStrictEqual({ ok: true, profiles: [fresh] });
      expect(await readFile(`${store}.bak`, 'utf8')).toBe('corrupt');
    });

    it('reports a store it cannot write', async () => {
      await writeFile(path.join(dir, 'plain'), 'x');
      const blocked = path.join(dir, 'plain', 'profiles.json');
      const result = await saveProfile(blocked, profile('a'), MODES);
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error).toContain(`Cannot write ${blocked}: `);
    });
  });

  describe('deleteProfile', () => {
    it('removes the profile with that id and nothing else', async () => {
      await saveProfile(store, profile('a'), MODES);
      await saveProfile(store, profile('b'), MODES);
      expect(await deleteProfile(store, 'a')).toStrictEqual({ ok: true, profiles: [profile('b')] });
      expect(await deleteProfile(store, 'missing')).toStrictEqual({
        ok: true,
        profiles: [profile('b')],
      });
      const listed = await listProfiles(store);
      expect(listed.profiles).toStrictEqual([profile('b')]);
    });
  });
});
