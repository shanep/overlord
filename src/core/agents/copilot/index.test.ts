import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTemporaryDirectory, removeDir } from '../../transcripts/test-helpers/fixtures.js';
import { agents } from '../index.js';

import { formatVerified, nanoAiuToUsd } from './models.js';

import { copilot } from './index.js';

// cspell:words xhigh Aiu

describe('copilot', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTemporaryDirectory();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it('names itself and is registered', () => {
    expect([copilot.id, copilot.name, copilot.short, copilot.icon]).toStrictEqual([
      'copilot',
      'Copilot CLI',
      'Copilot',
      'copilot',
    ]);
    expect(agents.list().map((adapter) => adapter.id)).toContain('copilot');
    expect(agents.get('copilot')).toBe(copilot);
  });

  it('only claims what milestone 1 can show', () => {
    expect(copilot.capabilities).toStrictEqual({
      launch: false,
      terminal: false,
      background: false,
      resume: false,
      fork: false,
      interrupt: false,
      liveModelChange: false,
      livePermissionMode: false,
      approvals: false,
      subagents: true,
      cacheReads: true,
      cacheWrites: true,
      costUsd: true,
      contextInspector: false,
      hooks: false,
      messaging: false,
      handoffs: [],
    });
    expect(copilot.terminal).toBeUndefined();
    expect(copilot.runtime).toBeUndefined();
    expect(copilot.hooks).toBeUndefined();
  });

  it('lists the modes and effort levels Copilot takes', () => {
    expect(copilot.modes.permission.map((mode) => mode.id)).toStrictEqual([
      'interactive',
      'plan',
      'autopilot',
      'allow-all',
    ]);
    const risky = copilot.modes.permission.filter((mode) => mode.risky === true);
    expect(risky.map((mode) => mode.id)).toStrictEqual(['allow-all']);
    expect(copilot.modes.effort.map((mode) => mode.id)).toStrictEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('knows the windows the data reported and leaves prices to Copilot', () => {
    const { models } = copilot;
    expect(models.defaultModel).toBe('auto');
    expect(models.contextWindow('gpt-5-mini')).toBe(128_000);
    expect(models.contextWindow('gpt-5-mini', 150_000)).toBe(150_000);
    expect(models.contextWindow('claude-sonnet-4.5')).toBeNull();
    expect(models.contextWindow(null)).toBeNull();
    expect(models.price('gpt-5-mini')).toBeNull();
    expect(nanoAiuToUsd(1e9)).toBeCloseTo(0.01, 12);
  });

  it('trusts the event format only from versions it was tested on', () => {
    expect(formatVerified('1.0.89')).toBe(true);
    expect(formatVerified('1.0.90')).toBe(false);
    expect(formatVerified('0.0.0')).toBe(false);
    expect(formatVerified(null)).toBe(false);
  });

  it('finds copilot on PATH without running it', async () => {
    const bin = path.join(dir, 'copilot');
    await writeFile(bin, '#!/bin/sh\nexit 1\n');
    await chmod(bin, 0o755);
    expect(await copilot.detect({ env: { PATH: dir }, platform: 'linux', path: '' })).toStrictEqual(
      {
        bin,
        version: null,
      },
    );
    expect(
      await copilot.detect({
        env: { PATH: path.join(dir, 'none') },
        platform: 'darwin',
        path: ' ',
      }),
    ).toStrictEqual({ bin: null, version: null });
    expect(
      await copilot.detect({ env: {}, platform: 'linux', path: '/opt/copilot' }),
    ).toStrictEqual({ bin: '/opt/copilot', version: null });
  });
});
