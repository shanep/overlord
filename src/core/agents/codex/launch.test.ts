import { describe, expect, it } from 'vitest';

import type { LaunchProfile } from '../../../shared/model.js';
import { configArgs } from '../../knobs/launch.js';

import { codexInject } from './inject.js';
import { codexLaunchOverrides, parseConfigPair, splitConfigArgs } from './launch.js';

function profile(extraArgs: readonly string[]): LaunchProfile {
  return {
    id: 'p',
    agent: 'codex',
    name: 'Codex',
    model: 'gpt-6-luna',
    effort: 'low',
    permissionMode: 'on-request/workspace-write',
    env: { A: '1' },
    extraArgs,
  };
}

describe('parseConfigPair', () => {
  it('splits at the first = that leaves a whole key and keeps the value as written', () => {
    expect(parseConfigPair('model="o3"')).toStrictEqual({ key: ['model'], raw: '"o3"' });
    expect(parseConfigPair('shell_environment_policy.inherit=all')).toStrictEqual({
      key: ['shell_environment_policy', 'inherit'],
      raw: 'all',
    });
    expect(parseConfigPair('projects."/a=b".trust_level="trusted"')).toStrictEqual({
      key: ['projects', '/a=b', 'trust_level'],
      raw: '"trusted"',
    });
    expect(parseConfigPair('otel.exporter={otlp-http={endpoint="x"}}')).toStrictEqual({
      key: ['otel', 'exporter'],
      raw: '{otlp-http={endpoint="x"}}',
    });
  });

  it('refuses a pair with no key', () => {
    expect(() => parseConfigPair('no-equals')).toThrow('is not key=value');
    expect(() => parseConfigPair('=1')).toThrow('is not key=value');
  });
});

describe('splitConfigArgs', () => {
  it('takes every -c and --config pair, in order, and leaves the other flags', () => {
    expect(
      splitConfigArgs([
        '-c',
        'a=1',
        '--search',
        '--config',
        'b="two"',
        '--config=c.d=true',
        '--enable',
        'web',
      ]),
    ).toStrictEqual({
      config: [
        { key: ['a'], raw: '1' },
        { key: ['b'], raw: '"two"' },
        { key: ['c', 'd'], raw: 'true' },
      ],
      rest: ['--search', '--enable', 'web'],
    });
  });

  it('refuses a -c with nothing after it', () => {
    expect(() => splitConfigArgs(['-c'])).toThrow('-c needs a key=value after it');
  });
});

describe('codexLaunchOverrides', () => {
  it('keeps every config pair, so two -c flags both reach the launch', () => {
    const overrides = codexLaunchOverrides(
      profile(['-c', 'web_search="live"', '-c', 'model_verbosity="low"', '--strict-config']),
    );
    expect(overrides).toStrictEqual({
      model: 'gpt-6-luna',
      effort: 'low',
      permissionMode: 'on-request/workspace-write',
      env: { A: '1' },
      extraArgs: { 'strict-config': null },
      config: [
        { key: ['web_search'], raw: '"live"' },
        { key: ['model_verbosity'], raw: '"low"' },
      ],
    });
    expect(configArgs(overrides.config)).toStrictEqual([
      '-c',
      'web_search="live"',
      '-c',
      'model_verbosity="low"',
    ]);
  });
});

describe('codexInject', () => {
  it('adds the text to developer_instructions, before any hook can run', () => {
    expect(codexInject.launchFirst).toBe(true);
    expect(codexInject.launchArgs?.('Say "hi"\nthen go')).toStrictEqual([
      '-c',
      String.raw`developer_instructions="Say \"hi\"\nthen go"`,
    ]);
    expect(codexInject.launchConfig?.('x')).toStrictEqual([
      { key: ['developer_instructions'], value: 'x' },
    ]);
  });
});
