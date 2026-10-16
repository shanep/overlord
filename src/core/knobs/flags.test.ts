// cspell:ignore tengu statsig cachedlower
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as flagsModule from './flags.js';
import { pickFeatureFlags, readFeatureFlags } from './flags.js';

describe('flags', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-knobs-flags-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const CLAUDE_JSON = {
    oauthAccount: { emailAddress: 'someone@example.com', accountUuid: 'acct-123' },
    userID: 'user-secret-id',
    machineID: 'machine-secret-id',
    primaryApiKey: 'sk-ant-secret',
    numStartups: 12,
    cachedGrowthBookFeatures: { tengu_feature: true, tengu_value: { on: 1 } },
    cachedGrowthBookFeaturesAt: 1_700_000_000_000,
    cachedExperimentFeatures: ['exp-a', 'exp-b'],
    cachedExperimentData: { exp: { variant: 'b' } },
    cachedStatsigGates: { gate: false },
    cachedDynamicConfigs: { config: { x: 1 } },
    cachedOtherFlags: { other: true },
    cachedNewFeatures: { brand_new: true },
    cachedUserFeatures: { leak: true },
    cachedOauthFlags: { leak: true },
    cachedAuthGates: { leak: true },
    cachedTokenConfigs: { leak: true },
    cachedEmailFeatures: { leak: true },
    cachedStringFeatures: 'not a map',
    cachedChromeExtensionInstalled: true,
    cachedArtifactRoster: { a: 'b' },
    cachedlowerFeatures: { no: true },
    someCachedFeatures: { no: true },
  };

  const EXPECTED_FLAGS = {
    cachedGrowthBookFeatures: { tengu_feature: true, tengu_value: { on: 1 } },
    cachedExperimentFeatures: ['exp-a', 'exp-b'],
    cachedExperimentData: { exp: { variant: 'b' } },
    cachedStatsigGates: { gate: false },
    cachedDynamicConfigs: { config: { x: 1 } },
    cachedOtherFlags: { other: true },
    cachedNewFeatures: { brand_new: true },
  };

  describe('pickFeatureFlags', () => {
    it('keeps only allowlisted flag maps', () => {
      expect(pickFeatureFlags(CLAUDE_JSON)).toStrictEqual(EXPECTED_FLAGS);
    });

    it('never returns account, user, machine or key data', () => {
      const text = JSON.stringify(pickFeatureFlags(CLAUDE_JSON));
      for (const secret of [
        'someone@example.com',
        'acct-123',
        'user-secret-id',
        'machine-secret-id',
        'sk-ant',
        'leak',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('returns nothing for data that is not an object', () => {
      expect(pickFeatureFlags(null)).toStrictEqual({});
      expect(pickFeatureFlags([CLAUDE_JSON])).toStrictEqual({});
      expect(pickFeatureFlags('cachedGrowthBookFeatures')).toStrictEqual({});
    });

    it('skips a known flag key whose value is not a map', () => {
      expect(
        pickFeatureFlags({ cachedGrowthBookFeatures: 'x', cachedStatsigGates: null }),
      ).toStrictEqual({});
    });
  });

  describe('readFeatureFlags', () => {
    it('reads the flag maps from ~/.claude.json', async () => {
      const claudeJson = path.join(dir, '.claude.json');
      await writeFile(claudeJson, JSON.stringify(CLAUDE_JSON));
      expect(await readFeatureFlags({ claudeJson })).toStrictEqual({
        flags: EXPECTED_FLAGS,
        error: null,
      });
    });

    it('is empty with no error when the file does not exist', async () => {
      expect(await readFeatureFlags({ claudeJson: path.join(dir, 'missing.json') })).toStrictEqual({
        flags: {},
        error: null,
      });
    });

    it('reports invalid JSON and unreadable paths without the file content', async () => {
      const claudeJson = path.join(dir, '.claude.json');
      await writeFile(claudeJson, '{"userID": "user-secret-id",');
      const invalid = await readFeatureFlags({ claudeJson });
      expect(invalid.flags).toStrictEqual({});
      expect(invalid.error).toContain(`Invalid JSON in ${claudeJson}: `);
      const folder = path.join(dir, 'folder');
      await mkdir(folder);
      const unreadable = await readFeatureFlags({ claudeJson: folder });
      expect(unreadable.flags).toStrictEqual({});
      expect(unreadable.error).toContain(`Cannot read ${folder}: `);
      expect(unreadable.error).toContain('EISDIR');
    });

    it('offers no way to write the cache', () => {
      expect(
        Object.keys(flagsModule).toSorted((left, right) => left.localeCompare(right)),
      ).toStrictEqual(['pickFeatureFlags', 'readFeatureFlags']);
    });
  });
});
