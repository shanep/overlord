// cspell:ignore modelx
import { describe, expect, it } from 'vitest';

import type { EffectiveValue, KnobDefinition, LaunchProfile } from '../../../src/shared/model.js';
import { knobsState } from '../../test/fixtures-context.js';

import {
  effectiveFor,
  effectiveKey,
  flagInProfile,
  indexEffective,
  knobEntries,
  profilesWithFlag,
  unlistedDefinition,
  unlistedEffective,
  withFlag,
  withoutFlag,
} from './knobs-match.js';

const base: KnobDefinition = {
  key: 'k',
  kind: 'setting',
  area: 'other',
  valueType: 'json',
  defaultValue: null,
  allowed: [],
  description: '',
  docUrl: 'https://example.com',
  appliesAt: 'next-launch',
  managedOnly: false,
};

function value(key: string, layer: EffectiveValue['layer'], set: unknown): EffectiveValue {
  return { key, value: set, layer, chain: [{ layer, value: set, file: `/${layer}.json` }] };
}

const profile: LaunchProfile = {
  id: 'p',
  agent: 'claude-code',
  name: 'P',
  model: null,
  effort: null,
  permissionMode: null,
  env: {},
  extraArgs: ['--a', '--max-turns', '5', '--b=x', '--c'],
};

describe('effectiveKey', () => {
  it('puts env vars under env and has nothing for flags', () => {
    expect(effectiveKey(base)).toBe('k');
    expect(effectiveKey({ ...base, kind: 'env' })).toBe('env.k');
    expect(effectiveKey({ ...base, kind: 'flag' })).toBeNull();
  });
});

describe('effectiveFor', () => {
  it('finds exact keys and env vars, never flags', () => {
    const index = indexEffective([value('k', 'user', 1), value('env.E', 'env', '2')]);
    expect(effectiveFor(base, index)?.value).toBe(1);
    expect(effectiveFor({ ...base, key: 'E', kind: 'env' }, index)?.value).toBe('2');
    expect(effectiveFor({ ...base, key: 'E', kind: 'flag' }, index)).toBeUndefined();
    expect(effectiveFor({ ...base, key: 'missing' }, index)).toBeUndefined();
  });

  it('builds one object from children set across layers, per layer in the chain', () => {
    const index = indexEffective([
      value('sandbox.enabled', 'project', true),
      {
        key: 'sandbox.network.allowedDomains',
        value: ['a', 'b'],
        layer: 'user',
        chain: [
          { layer: 'user', value: ['a'], file: '/u.json' },
          { layer: 'managed', value: ['b'], file: '/m.json' },
        ],
      },
      value('sandboxed', 'user', 1),
    ]);
    const composed = effectiveFor({ ...base, key: 'sandbox' }, index);
    expect(composed).toStrictEqual({
      key: 'sandbox',
      value: { enabled: true, network: { allowedDomains: ['a', 'b'] } },
      layer: 'managed',
      chain: [
        { layer: 'managed', value: { network: { allowedDomains: ['b'] } }, file: '/m.json' },
        { layer: 'project', value: { enabled: true }, file: '/project.json' },
        { layer: 'user', value: { network: { allowedDomains: ['a'] } }, file: '/u.json' },
      ],
    });
  });

  it('replaces a non object on the way down', () => {
    const index = indexEffective([
      value('a.b', 'user', 1),
      value('a.b.c', 'user', 2),
      value('a.d.e', 'user', 3),
      value('a.d.f', 'user', 4),
    ]);
    expect(effectiveFor({ ...base, key: 'a' }, index)?.value).toStrictEqual({
      b: { c: 2 },
      d: { e: 3, f: 4 },
    });
  });
});

describe('unlistedEffective', () => {
  it('keeps keys and env vars no catalog knob covers', () => {
    const unlisted = unlistedEffective(knobsState.catalog, [
      ...knobsState.effective,
      value('hooks.Stop', 'user', []),
      value('modelx', 'user', 'x'),
    ]);
    expect(unlisted.map((item) => item.key)).toStrictEqual(['env.MY_VAR', 'hooks.Stop', 'modelx']);
  });
});

describe('unlistedDefinition', () => {
  it('guesses the value type and says what the key is', () => {
    expect(unlistedDefinition(value('env.X', 'user', 'a'))).toMatchObject({
      key: 'env.X',
      kind: 'setting',
      valueType: 'string',
      description: 'An env var the docs do not list.',
      docUrl: '',
    });
    expect(unlistedDefinition(value('x', 'user', true)).valueType).toBe('boolean');
    expect(unlistedDefinition(value('x', 'user', 3)).valueType).toBe('number');
    expect(unlistedDefinition(value('x', 'user', [])).valueType).toBe('json');
    expect(unlistedDefinition(value('x', 'user', 1)).description).toBe(
      'A key the docs do not list.',
    );
  });
});

describe('flags in profiles', () => {
  it('reads bare, spaced and joined values', () => {
    expect(flagInProfile(profile, '--a')).toBeNull();
    expect(flagInProfile(profile, '--max-turns')).toBe('5');
    expect(flagInProfile(profile, '--b')).toBe('x');
    expect(flagInProfile(profile, '--c')).toBeNull();
    expect(flagInProfile(profile, '--d')).toBeUndefined();
  });

  it('removes a flag with its value token and keeps the rest', () => {
    expect(withoutFlag(profile.extraArgs, '--max-turns')).toStrictEqual(['--a', '--b=x', '--c']);
    expect(withoutFlag(profile.extraArgs, '--a')).toStrictEqual([
      '--max-turns',
      '5',
      '--b=x',
      '--c',
    ]);
    expect(withoutFlag(profile.extraArgs, '--b')).toStrictEqual(['--a', '--max-turns', '5', '--c']);
  });

  it('sets a flag once, bare or with a value', () => {
    expect(withFlag(['--max-turns', '5'], '--max-turns', '9')).toStrictEqual(['--max-turns=9']);
    expect(withFlag([], '--c', null)).toStrictEqual(['--c']);
  });

  it('names the profiles that pass a flag and builds entries', () => {
    expect(profilesWithFlag(knobsState.profiles, '--verbose')).toStrictEqual(['Fast']);
    const entries = knobEntries(knobsState.catalog, knobsState.effective, knobsState.profiles);
    expect(entries.find((entry) => entry.definition.key === '--verbose')?.profiles).toStrictEqual([
      'Fast',
    ]);
    expect(entries.find((entry) => entry.definition.key === 'model')?.profiles).toStrictEqual([]);
  });
});
