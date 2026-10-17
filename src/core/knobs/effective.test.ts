import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { SettingsLayer } from '../../shared/model.js';
import { claudeKnobs } from '../agents/claude/config.js';

import {
  computeEffective,
  flattenSettings,
  isSecretKey,
  layerOrder,
  REDACTED,
} from './effective.js';
import type { LayerData } from './layers.js';

const LAYER_ORDER = layerOrder(claudeKnobs);

/** Claude Code's precedence and merge rules, which most cases here pin down. */
function effectiveOf(layers: readonly LayerData[]): ReturnType<typeof computeEffective> {
  return computeEffective(layers, claudeKnobs);
}

function layer(
  name: SettingsLayer,
  values: Record<string, unknown>,
  file: string | null = null,
): LayerData {
  return { layer: name, file, values, error: null };
}

describe('layerOrder', () => {
  it('ranks managed highest and default lowest for Claude Code', () => {
    expect(LAYER_ORDER).toStrictEqual([
      'managed',
      'cli',
      'project-local',
      'project',
      'user',
      'env',
      'default',
    ]);
  });
});

describe('flattenSettings', () => {
  it('flattens nested objects into dotted keys and keeps arrays whole', () => {
    expect([
      ...flattenSettings({
        model: 'opus',
        permissions: { allow: ['Read'], defaultMode: 'plan', deep: { deeper: 1 } },
        hooks: {},
        nothing: null,
        list: [{ a: 1 }],
      }),
    ]).toStrictEqual([
      ['model', 'opus'],
      ['permissions.allow', ['Read']],
      ['permissions.defaultMode', 'plan'],
      ['permissions.deep.deeper', 1],
      ['hooks', {}],
      ['nothing', null],
      ['list', [{ a: 1 }]],
    ]);
  });

  it('returns nothing for an empty object', () => {
    expect(flattenSettings({}).size).toBe(0);
  });
});

describe('isSecretKey', () => {
  it.each([
    ['env.ANTHROPIC_API_KEY', true],
    ['env.ANTHROPIC_AUTH_TOKEN', true],
    ['env.AWS_SECRET_ACCESS_KEY', true],
    ['env.DB_PASSWORD', true],
    ['env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE', true],
    ['env.MY_CREDENTIALS', true],
    ['env.ANTHROPIC_CUSTOM_HEADERS', true],
    ['env.SESSION_COOKIE', true],
    ['env.github_token', true],
    ['env.ANTHROPIC_MODEL', false],
    ['env.PATH', false],
    ['apiKeyHelper', false],
    ['envTOKEN', false],
    ['not.TOKEN_X', false],
    ['env.', false],
  ])('%s is secret: %s', (key, secret) => {
    expect(isSecretKey(key)).toBe(secret);
  });
});

describe('computeEffective', () => {
  it('lets the highest layer win and records the whole chain', () => {
    const effective = effectiveOf([
      layer('user', { model: 'haiku', theme: 'dark' }, '/u.json'),
      layer('managed', { model: 'opus' }, '/m.json'),
      layer('project', { model: 'sonnet' }, '/p.json'),
    ]);
    expect(effective).toStrictEqual([
      {
        key: 'model',
        value: 'opus',
        layer: 'managed',
        chain: [
          { layer: 'managed', value: 'opus', file: '/m.json' },
          { layer: 'project', value: 'sonnet', file: '/p.json' },
          { layer: 'user', value: 'haiku', file: '/u.json' },
        ],
      },
      {
        key: 'theme',
        value: 'dark',
        layer: 'user',
        chain: [{ layer: 'user', value: 'dark', file: '/u.json' }],
      },
    ]);
  });

  it('sorts keys and returns nothing for empty layers', () => {
    expect(effectiveOf([])).toStrictEqual([]);
    expect(effectiveOf([layer('user', {})])).toStrictEqual([]);
    const keys = effectiveOf([layer('user', { b: 1, a: 2, 'a.b': 3, A: 4 })]).map(
      (item) => item.key,
    );
    expect(keys).toStrictEqual(['A', 'a', 'a.b', 'b']);
  });

  it('merges list keys across layers, highest first, without duplicates', () => {
    const [allow] = effectiveOf([
      layer('user', { permissions: { allow: ['Read', 'Bash(ls)'] } }),
      layer('project-local', { permissions: { allow: ['Edit', 'Read'] } }),
      layer('managed', { permissions: { allow: [{ tool: 'x' }] } }),
      layer('cli', { permissions: { allow: [{ tool: 'x' }, 'Edit'] } }),
    ]);
    expect(allow?.key).toBe('permissions.allow');
    expect(allow?.layer).toBe('managed');
    expect(allow?.value).toStrictEqual([{ tool: 'x' }, 'Edit', 'Read', 'Bash(ls)']);
    expect(allow?.chain.map((link) => link.layer)).toStrictEqual([
      'managed',
      'cli',
      'project-local',
      'user',
    ]);
  });

  it('ignores lower values that are not lists when merging', () => {
    const [dirs] = effectiveOf([
      layer('project', { additionalDirectories: ['../a'] }),
      layer('user', { additionalDirectories: 'oops' }),
    ]);
    expect(dirs?.value).toStrictEqual(['../a']);
    const [scalar] = effectiveOf([
      layer('project', { additionalDirectories: 'winner' }),
      layer('user', { additionalDirectories: ['../b'] }),
    ]);
    expect(scalar?.value).toBe('winner');
  });

  it('does not merge fallbackModel or modelPicker', () => {
    const effective = effectiveOf([
      layer('user', { fallbackModel: ['haiku'], modelPicker: { options: ['b'] } }),
      layer('project', { fallbackModel: ['sonnet', 'opus'], modelPicker: ['x'] }),
      layer('managed', { modelPicker: { options: ['a'] } }),
      layer('cli', { modelPicker: ['y'] }),
    ]);
    expect(effective.find((item) => item.key === 'fallbackModel')?.value).toStrictEqual([
      'sonnet',
      'opus',
    ]);
    expect(effective.find((item) => item.key === 'modelPicker.options')?.value).toStrictEqual([
      'a',
    ]);
    expect(effective.find((item) => item.key === 'modelPicker')?.value).toStrictEqual(['y']);
  });

  it('applies a managed availableModels list as-is and merges it otherwise', () => {
    const managed = effectiveOf([
      layer('managed', { availableModels: ['opus'] }),
      layer('user', { availableModels: ['haiku'] }),
    ]);
    expect(managed[0]?.value).toStrictEqual(['opus']);
    const unmanaged = effectiveOf([
      layer('project', { availableModels: ['opus'] }),
      layer('user', { availableModels: ['haiku'] }),
    ]);
    expect(unmanaged[0]?.value).toStrictEqual(['opus', 'haiku']);
    const otherManaged = effectiveOf([
      layer('managed', { deniedModels: ['opus'] }),
      layer('user', { deniedModels: ['haiku'] }),
    ]);
    expect(otherManaged[0]?.value).toStrictEqual(['opus', 'haiku']);
  });

  it('includes env blocks from files and the process env with their layers', () => {
    const effective = effectiveOf([
      layer('env', { env: { ANTHROPIC_MODEL: 'shell', DEBUG: '1' } }),
      layer('user', { env: { ANTHROPIC_MODEL: 'file' } }, '/u.json'),
    ]);
    expect(effective).toStrictEqual([
      {
        key: 'env.ANTHROPIC_MODEL',
        value: 'file',
        layer: 'user',
        chain: [
          { layer: 'user', value: 'file', file: '/u.json' },
          { layer: 'env', value: 'shell', file: null },
        ],
      },
      {
        key: 'env.DEBUG',
        value: '1',
        layer: 'env',
        chain: [{ layer: 'env', value: '1', file: null }],
      },
    ]);
  });

  it('redacts secret env values in the value and the chain', () => {
    const [secret] = effectiveOf([
      layer('env', { env: { ANTHROPIC_API_KEY: 'sk-shell' } }),
      layer('user', { env: { ANTHROPIC_API_KEY: 'sk-file' } }, '/u.json'),
    ]);
    expect(secret).toStrictEqual({
      key: 'env.ANTHROPIC_API_KEY',
      value: REDACTED,
      layer: 'user',
      chain: [
        { layer: 'user', value: REDACTED, file: '/u.json' },
        { layer: 'env', value: REDACTED, file: null },
      ],
    });
    expect(JSON.stringify(secret)).not.toContain('sk-');
  });

  it('always picks the highest-precedence layer for a scalar key (property)', () => {
    const layerArb = fc.constantFrom<SettingsLayer>(...LAYER_ORDER);
    const entries = fc.uniqueArray(fc.tuple(layerArb, fc.integer()), {
      selector: ([name]) => name,
      minLength: 1,
    });
    fc.assert(
      fc.property(entries, (pairs) => {
        const layers = pairs.map(([name, value]) => layer(name, { k: value, [`z.${name}`]: 1 }));
        const effective = effectiveOf(layers).find((item) => item.key === 'k');
        const expected = pairs.toSorted(
          ([left], [right]) => LAYER_ORDER.indexOf(left) - LAYER_ORDER.indexOf(right),
        );
        expect(effective?.key).toBe('k');
        expect(effective?.layer).toBe(expected[0]?.[0]);
        expect(effective?.value).toBe(expected[0]?.[1]);
        expect(effective?.chain.map((link) => [link.layer, link.value])).toStrictEqual(expected);
      }),
    );
  });

  it('merges lists to the union of every layer, in precedence order (property)', () => {
    const layerArb = fc.constantFrom<SettingsLayer>(...LAYER_ORDER);
    const entries = fc.uniqueArray(fc.tuple(layerArb, fc.array(fc.string(), { maxLength: 4 })), {
      selector: ([name]) => name,
      minLength: 1,
    });
    fc.assert(
      fc.property(entries, (pairs) => {
        const layers = pairs.map(([name, list]) => layer(name, { permissions: { deny: list } }));
        const [effective] = effectiveOf(layers);
        const ordered = pairs
          .toSorted(([left], [right]) => LAYER_ORDER.indexOf(left) - LAYER_ORDER.indexOf(right))
          .flatMap(([, list]) => list);
        expect(effective?.value).toStrictEqual([...new Set(ordered)]);
      }),
    );
  });

  it('takes precedence and merge rules from the facet', () => {
    const facet = {
      layers: [
        { kind: 'env', layer: 'env' },
        { kind: 'cli', layer: 'cli' },
      ] as const,
      neverMerges: (key: string): boolean => key === 'chain',
      managedReplaces: new Set<string>(),
    };
    const effective = computeEffective(
      [
        layer('cli', { model: 'cli', chain: ['b'], list: ['b'] }),
        layer('env', { model: 'env', chain: ['a'], list: ['a'] }),
      ],
      facet,
    );
    expect(effective.map((item) => [item.key, item.value, item.layer])).toStrictEqual([
      ['chain', ['a'], 'env'],
      ['list', ['a', 'b'], 'env'],
      ['model', 'env', 'env'],
    ]);
    expect(layerOrder(facet)).toStrictEqual(['env', 'cli', 'default']);
  });
});
