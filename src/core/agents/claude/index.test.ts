import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_MODEL } from '../../app/prices.js';
import { DEFAULT_PRICES } from '../../transcripts/pricing.js';

import { claudeCode } from './index.js';

describe('claudeCode', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-agent-claude-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names itself and offers every Claude feature', () => {
    expect([claudeCode.id, claudeCode.name, claudeCode.short]).toStrictEqual([
      'claude-code',
      'Claude Code',
      'Claude',
    ]);
    expect(Object.values(claudeCode.capabilities).every((value) => value !== false)).toBe(true);
    expect(claudeCode.capabilities.handoffs).toStrictEqual([
      'resume-local',
      'open-desktop',
      'teleport-local',
      'remote-control',
    ]);
  });

  it('lists the permission modes and effort levels Claude takes', () => {
    expect(claudeCode.modes.permission.map((mode) => mode.id)).toStrictEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'dontAsk',
      'bypassPermissions',
      'manual',
    ]);
    const risky = claudeCode.modes.permission.filter((mode) => mode.risky === true);
    expect(risky.map((mode) => mode.id)).toStrictEqual(['bypassPermissions']);
    expect(claudeCode.modes.effort.map((mode) => mode.id)).toStrictEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('uses the shared context windows and price table', () => {
    const { models } = claudeCode;
    expect(models.defaultModel).toBe(DEFAULT_MODEL);
    expect(models.contextWindow('claude-sonnet-4-5')).toBe(200_000);
    expect(models.contextWindow('claude-opus-5-5')).toBe(1_000_000);
    expect(models.contextWindow(null)).toBeNull();
    expect(models.price('claude-opus-5-5')).toBe(DEFAULT_PRICES['claude-opus-5-5']);
    expect(models.price('gpt-5')).toBeNull();
  });

  it('finds claude on PATH without running it', async () => {
    const bin = path.join(dir, 'claude');
    await writeFile(bin, '#!/bin/sh\nexit 1\n');
    await chmod(bin, 0o755);
    expect(
      await claudeCode.detect({ env: { PATH: dir }, platform: 'linux', path: '' }),
    ).toStrictEqual({ bin, version: null });
    expect(
      await claudeCode.detect({
        env: { PATH: path.join(dir, 'none') },
        platform: 'linux',
        path: '',
      }),
    ).toStrictEqual({ bin: null, version: null });
    expect(
      await claudeCode.detect({ env: {}, platform: 'linux', path: '/opt/claude' }),
    ).toStrictEqual({ bin: '/opt/claude', version: null });
  });
});
