import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ownValue, stableJson } from './json.js';
import {
  applyDrift,
  deepMerge,
  detectDrift,
  type DriftEntry,
  generateSettings,
  generateSettingsFromRepo,
  splitDrift,
} from './settings-gen.js';
import { scratchDir, writeTree } from './test-helpers/fixtures.js';

describe('deepMerge', () => {
  it('merges objects, concatenates arrays without duplicates, and lets the override win', () => {
    const global = {
      model: 'opus',
      permissions: { allow: ['Read', 'Bash(git:*)'], deny: ['x'] },
      env: { A: '1' },
      hooks: [{ a: 1 }],
    };
    const machine = {
      model: 'sonnet',
      permissions: { allow: ['Bash(git:*)', 'Edit'] },
      env: { B: '2' },
      hooks: [{ a: 1 }, { b: 2 }],
      extra: null,
    };
    expect(deepMerge(global, machine)).toStrictEqual({
      model: 'sonnet',
      permissions: { allow: ['Read', 'Bash(git:*)', 'Edit'], deny: ['x'] },
      env: { A: '1', B: '2' },
      hooks: [{ a: 1 }, { b: 2 }],
      extra: null,
    });
  });

  it('replaces when the shapes differ and keeps base for undefined', () => {
    expect(deepMerge({ a: 1 }, ['x'])).toStrictEqual(['x']);
    expect(deepMerge([1], { a: 1 })).toStrictEqual({ a: 1 });
    const unset: { readonly value?: unknown } = {};
    expect(deepMerge('x', unset.value)).toBe('x');
    expect(deepMerge(['a', 'a'], [])).toStrictEqual(['a']);
  });

  it('treats __proto__ and inherited names as ordinary keys', () => {
    const base: unknown = JSON.parse('{"a":1,"__proto__":{"x":1}}');
    const override: unknown = JSON.parse('{"__proto__":{"y":2},"toString":"s"}');
    const merged = generateSettings(base, override);
    const plain: unknown = Object.getPrototypeOf({});
    const mergedProto: unknown = Object.getPrototypeOf(merged);
    expect(mergedProto).toBe(plain);
    expect(Object.keys(merged)).toStrictEqual(['a', '__proto__', 'toString']);
    expect(JSON.stringify(merged)).toBe('{"a":1,"__proto__":{"x":1,"y":2},"toString":"s"}');
    expect(detectDrift({ toString: 'x' }, {})).toStrictEqual([
      { kind: 'added', path: ['toString'], current: 'x', generated: undefined },
    ]);
    expect(detectDrift({}, { constructor: 'x' })).toStrictEqual([
      { kind: 'removed', path: ['constructor'], current: undefined, generated: 'x' },
    ]);
    const applied = applyDrift({}, [
      { kind: 'added', path: ['__proto__', 'polluted'], current: 1, generated: undefined },
    ]);
    const appliedProto: unknown = Object.getPrototypeOf(applied);
    expect(appliedProto).toBe(plain);
    expect(JSON.stringify(applied)).toBe('{"__proto__":{"polluted":1}}');
    expect(
      splitDrift([{ kind: 'changed', path: ['toString'], current: 'a', generated: 'b' }], {}, '/h')
        .toGlobal,
    ).toHaveLength(1);
  });

  it('does not change its inputs', () => {
    const base = { a: { b: [1] } };
    deepMerge(base, { a: { b: [2], c: 3 } });
    expect(base).toStrictEqual({ a: { b: [1] } });
  });

  const json = fc.jsonValue({ maxDepth: 3 });
  const record = fc.dictionary(fc.string({ maxLength: 4 }), json, { maxKeys: 5 });

  it('lets the machine value win for every scalar key', () => {
    fc.assert(
      fc.property(record, record, (base, override) => {
        const merged = generateSettings(base, override);
        const scalars = Object.entries(override).filter(
          ([, value]) => typeof value !== 'object' || value === null,
        );
        const picked = scalars.map(([key]) => [key, ownValue(merged, key)]);
        expect(picked).toStrictEqual(scalars);
      }),
    );
  });

  it('keeps every key from both sides, and merging with {} changes nothing', () => {
    fc.assert(
      fc.property(record, record, (base, override) => {
        const merged = generateSettings(base, override);
        const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
        expect(new Set(Object.keys(merged))).toStrictEqual(keys);
        expect(stableJson(deepMerge(base, {}))).toBe(stableJson(base));
      }),
    );
  });

  it('keeps every array element from both sides, once', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 })),
        fc.array(fc.integer({ min: 0, max: 5 })),
        (a, b) => {
          const merged = deepMerge({ list: a }, { list: b });
          const list =
            typeof merged === 'object' && merged !== null && 'list' in merged ? merged.list : [];
          expect(list).toStrictEqual([...new Set([...a, ...b])]);
        },
      ),
    );
  });
});

describe('generateSettings', () => {
  it('treats non-objects as empty', () => {
    expect(generateSettings(null, ['x'])).toStrictEqual({});
    expect(generateSettings({ a: 1 }, 'x')).toStrictEqual({ a: 1 });
  });

  it('builds settings from the repo files, with a missing machine file as {}', async () => {
    const repo = await scratchDir();
    await writeTree(repo, {
      'global/settings.json': '{"model":"opus","env":{"A":"1"}}',
      'machines/box.json': '{"env":{"B":"2"}}',
    });
    const box = await generateSettingsFromRepo(repo, 'Box.local');
    expect(box.settings).toStrictEqual({ model: 'opus', env: { A: '1', B: '2' } });
    expect(box.content).toBe(stableJson(box.settings));
    expect(box.globalFile).toBe(`${repo}/global/settings.json`);
    expect(box.machineFile).toBe(`${repo}/machines/box.json`);
    const other = await generateSettingsFromRepo(repo, 'other');
    expect(other.settings).toStrictEqual({ model: 'opus', env: { A: '1' } });
  });

  it('honors a different global file and fails on bad JSON', async () => {
    const repo = await scratchDir();
    await writeTree(repo, { 'g/s.json': '{"a":1}', 'global/settings.json': '{' });
    const custom = await generateSettingsFromRepo(repo, 'h', 'g/s.json');
    expect(custom.settings).toStrictEqual({
      a: 1,
    });
    await expect(generateSettingsFromRepo(repo, 'h')).rejects.toThrow(
      `${repo}/global/settings.json is not valid JSON`,
    );
  });
});

describe('detectDrift', () => {
  it('finds added, removed, changed and array changes by key path', () => {
    const generated = {
      model: 'opus',
      permissions: { allow: ['Read', 'Edit'] },
      env: { A: '1', GONE: 'x' },
    };
    const current = {
      model: 'sonnet',
      permissions: { allow: ['Read', 'Bash'] },
      env: { A: '1' },
      theme: 'dark',
    };
    expect(detectDrift(current, generated)).toStrictEqual([
      { kind: 'removed', path: ['env', 'GONE'], current: undefined, generated: 'x' },
      { kind: 'changed', path: ['model'], current: 'sonnet', generated: 'opus' },
      { kind: 'array', path: ['permissions', 'allow'], added: ['Bash'], removed: ['Edit'] },
      { kind: 'added', path: ['theme'], current: 'dark', generated: undefined },
    ]);
  });

  it('finds nothing when the files match, ignoring order of keys', () => {
    expect(
      detectDrift({ a: { b: [1, { c: 1, d: 2 }] } }, { a: { b: [1, { d: 2, c: 1 }] } }),
    ).toStrictEqual([]);
    expect(detectDrift(null, 'x')).toStrictEqual([]);
  });

  it('reports a shape change as changed', () => {
    expect(detectDrift({ a: [1] }, { a: { b: 1 } })).toStrictEqual([
      { kind: 'changed', path: ['a'], current: [1], generated: { b: 1 } },
    ]);
  });
});

describe('splitDrift and applyDrift', () => {
  const drift: readonly DriftEntry[] = [
    { kind: 'changed', path: ['model'], current: 'sonnet', generated: 'opus' },
    { kind: 'added', path: ['env', 'JAVA_HOME'], current: '/h/jdk', generated: undefined },
    { kind: 'added', path: ['env', 'PYTHON'], current: '/home/other/py', generated: undefined },
    { kind: 'added', path: ['statusLine'], current: { command: 'x' }, generated: undefined },
    { kind: 'array', path: ['permissions', 'allow'], added: ['Bash'], removed: ['Edit'] },
    { kind: 'removed', path: ['theme'], current: undefined, generated: 'dark' },
    { kind: 'removed', path: ['gone'], current: undefined, generated: 1 },
  ];

  it('sends keys the machine file sets, and home paths, to the machine file', () => {
    const split = splitDrift(drift, { statusLine: { command: 'y' }, theme: 'light' }, '/h');
    expect(split.toMachine.map((entry) => entry.path.join('.'))).toStrictEqual([
      'env.JAVA_HOME',
      'env.PYTHON',
      'statusLine',
      'theme',
    ]);
    expect(split.toGlobal.map((entry) => entry.path.join('.'))).toStrictEqual([
      'model',
      'permissions.allow',
      'gone',
    ]);
  });

  it('applies changes to a settings object without touching the input', () => {
    const global = {
      model: 'opus',
      permissions: { allow: ['Read', 'Edit'] },
      theme: 'dark',
      env: 'odd',
    };
    const next = applyDrift(global, drift);
    expect(next).toStrictEqual({
      model: 'sonnet',
      permissions: { allow: ['Read', 'Bash'] },
      env: { JAVA_HOME: '/h/jdk', PYTHON: '/home/other/py' },
      statusLine: { command: 'x' },
    });
    expect(global.permissions.allow).toStrictEqual(['Read', 'Edit']);
    expect(
      applyDrift(null, [{ kind: 'array', path: ['a', 'b'], added: [1], removed: [] }]),
    ).toStrictEqual({
      a: { b: [1] },
    });
  });

  it('round trips: applying the split drift regenerates the live file', () => {
    const globalFile = { model: 'opus', permissions: { allow: ['Read', 'Edit'] }, theme: 'dark' };
    const machineFile = { theme: 'light' };
    const live = {
      model: 'sonnet',
      permissions: { allow: ['Read', 'Bash'] },
      theme: 'solar',
      env: { X: '/h/x' },
    };
    const found = detectDrift(live, generateSettings(globalFile, machineFile));
    const split = splitDrift(found, machineFile, '/h');
    const next = generateSettings(
      applyDrift(globalFile, split.toGlobal),
      applyDrift(machineFile, split.toMachine),
    );
    expect(next).toStrictEqual(live);
  });
});
