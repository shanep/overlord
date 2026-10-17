import { describe, expect, it } from 'vitest';

import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';

import {
  findProfile,
  mergeEnv,
  parseExtraArgs,
  sessionSettings,
  toEffortLevel,
  toPermissionMode,
  toSdkPermissionMode,
} from './options.js';

const spec: LaunchSpec = {
  prompt: 'Fix it',
  cwd: '/repo',
  profileId: 'p1',
  worktree: false,
  maxBudgetUsd: null,
  label: 'Fix it',
};

const profile: LaunchProfile = {
  id: 'p1',
  agent: 'claude-code',
  name: 'Opus high',
  model: 'opus',
  effort: 'high',
  permissionMode: 'acceptEdits',
  env: { FOO: 'profile', EXTRA: '1' },
  extraArgs: ['--verbose-tools', '--add-dir', '/tmp/x', '--name=value'],
};

describe('toEffortLevel', () => {
  it('accepts every SDK level and null', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(toEffortLevel(level)).toBe(level);
    }
    expect(toEffortLevel(null)).toBeNull();
  });

  it('rejects unknown levels', () => {
    expect(() => toEffortLevel('extreme')).toThrow('Unknown effort level "extreme"');
  });
});

describe('toSdkPermissionMode', () => {
  it('maps manual to default and passes the rest through', () => {
    expect(toSdkPermissionMode('manual')).toBe('default');
    expect(toSdkPermissionMode('plan')).toBe('plan');
    expect(toSdkPermissionMode('bypassPermissions')).toBe('bypassPermissions');
  });
});

describe('toPermissionMode', () => {
  it('accepts every Claude mode and null', () => {
    expect(toPermissionMode(null)).toBeNull();
    expect(toPermissionMode('plan')).toBe('plan');
    expect(toPermissionMode('manual')).toBe('manual');
  });

  it('rejects modes Claude does not have', () => {
    expect(() => toPermissionMode('yolo')).toThrow('Unknown permission mode "yolo"');
  });
});

describe('mergeEnv', () => {
  it('drops undefined values and lets overrides win', () => {
    expect(mergeEnv({ A: '1', B: undefined, FOO: 'base' }, { FOO: 'over' })).toStrictEqual({
      A: '1',
      FOO: 'over',
    });
  });
});

describe('parseExtraArgs', () => {
  it('reads flags, flag values and inline values', () => {
    expect(parseExtraArgs(['--debug', '--add-dir', '/x', '--a=b=c', '--last'])).toStrictEqual({
      debug: null,
      'add-dir': '/x',
      a: 'b=c',
      last: null,
    });
    expect(parseExtraArgs([])).toStrictEqual({});
  });

  it('rejects values with no flag', () => {
    expect(() => parseExtraArgs(['stray'])).toThrow(
      'Extra argument "stray" does not follow a --flag',
    );
    expect(() => parseExtraArgs(['--x=1', 'stray'])).toThrow('Extra argument "stray"');
    expect(() => parseExtraArgs(['--x', 'one', 'two'])).toThrow('Extra argument "two"');
  });
});

describe('findProfile', () => {
  it('finds the profile, null for none, and throws when missing', () => {
    expect(findProfile(spec, [profile])).toBe(profile);
    expect(findProfile({ ...spec, profileId: null }, [profile])).toBeNull();
    expect(() => findProfile({ ...spec, profileId: 'gone' }, [profile])).toThrow(
      'Unknown launch profile "gone"',
    );
  });
});

describe('sessionSettings', () => {
  it('builds settings from the profile', () => {
    expect(
      sessionSettings({ ...spec, maxBudgetUsd: 2 }, profile, { FOO: 'base', PATH: '/bin' }),
    ).toStrictEqual({
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
      env: { FOO: 'profile', PATH: '/bin', EXTRA: '1' },
      extraArgs: { 'verbose-tools': null, 'add-dir': '/tmp/x', name: 'value' },
      maxBudgetUsd: 2,
    });
  });

  it('uses defaults with no profile and no caps', () => {
    expect(sessionSettings(spec, null, { PATH: '/bin' })).toStrictEqual({
      model: null,
      effort: null,
      permissionMode: null,
      env: { PATH: '/bin' },
      extraArgs: {},
      maxBudgetUsd: null,
    });
  });
});
