import { describe, expect, it } from 'vitest';

import type { EffectiveValue, KnobDefinition } from '../../../src/shared/model.js';
import { knobDefinitions, knobsState } from '../../test/fixtures-context.js';

import { knobEntries } from './knobs-match.js';
import type { AreaGroup, KnobFilter } from './knobs-values.js';
import {
  areaNames,
  defaultLayer,
  displayValue,
  editorText,
  formatEnv,
  groupEntries,
  isEditableLayer,
  isKindFilter,
  isRetired,
  matchesQuery,
  nullIfEmpty,
  parseArgs,
  parseEnv,
  parseKnobInput,
  parseKnobValue,
  selectOptions,
  splitList,
  startText,
  startTextAt,
} from './knobs-values.js';

const base: KnobDefinition = {
  key: 'k',
  kind: 'setting',
  area: 'misc',
  valueType: 'string',
  defaultValue: null,
  allowed: [],
  description: 'A knob.',
  docUrl: 'https://example.com',
  appliesAt: 'live',
  managedOnly: false,
};

function effective(value: unknown): EffectiveValue {
  return { key: 'k', value, layer: 'user', chain: [] };
}

describe('parseKnobInput', () => {
  it('parses booleans from select text', () => {
    expect(parseKnobInput('boolean', 'true')).toStrictEqual({ ok: true, value: true });
    expect(parseKnobInput('boolean', 'false')).toStrictEqual({ ok: true, value: false });
  });

  it('parses numbers and rejects empty or bad text', () => {
    expect(parseKnobInput('number', ' 42 ')).toStrictEqual({ ok: true, value: 42 });
    expect(parseKnobInput('number', '')).toStrictEqual({ ok: false, error: 'Enter a number.' });
    expect(parseKnobInput('number', 'abc')).toStrictEqual({ ok: false, error: 'Enter a number.' });
  });

  it('parses JSON and reports invalid JSON', () => {
    expect(parseKnobInput('json', '{"a":1}')).toStrictEqual({ ok: true, value: { a: 1 } });
    expect(parseKnobInput('json', '{')).toStrictEqual({ ok: false, error: 'Not valid JSON.' });
  });

  it('splits string lists and keeps strings and enums as typed', () => {
    expect(parseKnobInput('string[]', 'a, b,,c ')).toStrictEqual({
      ok: true,
      value: ['a', 'b', 'c'],
    });
    expect(parseKnobInput('string', ' x ')).toStrictEqual({ ok: true, value: ' x ' });
    expect(parseKnobInput('enum', 'plan')).toStrictEqual({ ok: true, value: 'plan' });
  });
});

describe('splitList', () => {
  it('drops empty items', () => {
    expect(splitList('')).toStrictEqual([]);
    expect(splitList(' a ,b')).toStrictEqual(['a', 'b']);
  });
});

describe('editorText', () => {
  it('shows nothing for missing values', () => {
    expect(editorText('string')).toBe('');
    expect(editorText('json', null)).toBe('');
  });

  it('joins string lists and falls back to JSON for other list values', () => {
    expect(editorText('string[]', ['a', 'b'])).toBe('a, b');
    expect(editorText('string[]', [1, 2])).toBe('[1,2]');
  });

  it('keeps strings and pretty prints JSON', () => {
    expect(editorText('json', 'raw')).toBe('raw');
    expect(editorText('json', { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(editorText('number', 5)).toBe('5');
    expect(editorText('boolean', true)).toBe('true');
  });
});

describe('startText', () => {
  it('prefers the effective value over the default', () => {
    expect(startText({ ...base, defaultValue: 'd' }, effective('e'))).toBe('e');
    expect(startText({ ...base, defaultValue: 'd' })).toBe('d');
    expect(startText(base)).toBe('');
  });

  it('keeps boolean text to true or false', () => {
    const definition: KnobDefinition = { ...base, valueType: 'boolean' };
    expect(startText(definition, effective(true))).toBe('true');
    expect(startText(definition)).toBe('false');
  });

  it('picks the first allowed enum value when the current one is not allowed', () => {
    const definition: KnobDefinition = { ...base, valueType: 'enum', allowed: ['a', 'b'] };
    expect(startText(definition, effective('b'))).toBe('b');
    expect(startText(definition, effective('z'))).toBe('a');
    expect(startText({ ...definition, allowed: [] })).toBe('');
  });
});

describe('displayValue', () => {
  it('shows the effective value, then the default, then unset', () => {
    expect(displayValue(base, effective(50))).toBe('50');
    expect(displayValue({ ...base, defaultValue: '30' })).toBe('30 (default)');
    expect(displayValue(base)).toBe('unset');
  });
});

const ALL: KnobFilter = { query: '', kind: 'all', onlySet: false, showRetired: false };

function groupsFor(filter: Partial<KnobFilter>): AreaGroup[] {
  const entries = knobEntries(knobsState.catalog, knobsState.effective, knobsState.profiles);
  return groupEntries(entries, { ...ALL, ...filter });
}

describe('matchesQuery and groupEntries', () => {
  it('matches every word against key, description, area or area title without case', () => {
    expect(matchesQuery(base, '')).toBe(true);
    expect(matchesQuery(base, ' KNOB ')).toBe(true);
    expect(matchesQuery(base, 'MISC')).toBe(true);
    expect(matchesQuery(base, 'k knob')).toBe(true);
    expect(matchesQuery(base, 'knob zzz')).toBe(false);
    expect(matchesQuery({ ...base, area: 'bash' }, 'sandbox')).toBe(true);
  });

  it('groups in area order with settings, then env vars, then flags, by key', () => {
    const groups = groupsFor({});
    expect(groups.map((group) => group.area)).toStrictEqual([
      'model',
      'thinking',
      'permissions',
      'bash',
      'sessions',
      'ui',
    ]);
    expect(groups[0]).toMatchObject({ title: 'Model and output', setCount: 2 });
    expect(groups[2]?.entries.map((entry) => entry.definition.key)).toStrictEqual([
      'additionalDirectories',
      'permissions',
      'permissions.defaultMode',
    ]);
  });

  it('sorts kinds before keys and unknown areas last by name', () => {
    const extra: KnobDefinition[] = [
      { ...base, key: 'a', kind: 'flag', area: 'zeta' },
      { ...base, key: 'b', kind: 'setting', area: 'zeta' },
      { ...base, key: 'c', kind: 'env', area: 'alpha' },
    ];
    const groups = groupEntries(knobEntries(extra, [], []), ALL);
    expect(groups.map((group) => [group.area, group.title, group.summary])).toStrictEqual([
      ['alpha', 'alpha', ''],
      ['zeta', 'zeta', ''],
    ]);
    expect(groups[1]?.entries.map((entry) => entry.definition.key)).toStrictEqual(['b', 'a']);
  });

  it('filters by kind, what is set, removed keys and text', () => {
    expect(groupsFor({ kind: 'flag' }).map((group) => group.area)).toStrictEqual([
      'sessions',
      'ui',
    ]);
    expect(
      groupsFor({ onlySet: true }).flatMap((group) =>
        group.entries.map((entry) => entry.definition.key),
      ),
    ).toStrictEqual(['env', 'model', 'permissions', 'BASH_MAX_OUTPUT_LENGTH', '--verbose']);
    expect(groupsFor({ showRetired: true }).at(-1)?.area).toBe('other');
    expect(groupsFor({ query: 'shell' }).map((group) => group.area)).toStrictEqual(['bash']);
    expect(groupsFor({ query: 'nothing here' })).toStrictEqual([]);
  });

  it('shows a removed key that is still set', () => {
    const set = [{ key: 'env.OLD_SWITCH', value: '1', layer: 'user' as const, chain: [] }];
    const entries = knobEntries(knobDefinitions, set, []);
    expect(groupEntries(entries, ALL).at(-1)?.area).toBe('other');
  });

  it('knows removed keys and kind filter values', () => {
    expect(isRetired({ ...base, description: 'Removed in v2. Gone.' })).toBe(true);
    expect(isRetired({ ...base, description: 'Deprecated; use x.' })).toBe(true);
    expect(isRetired({ ...base, description: 'Sets a thing. Removed in v2.' })).toBe(false);
    expect(
      ['all', 'setting', 'env', 'flag', 'nope', 3].map((item) => isKindFilter(item)),
    ).toStrictEqual([true, true, true, true, false, false]);
  });
});

describe('editing helpers', () => {
  it('offers env spellings for env switches', () => {
    expect(selectOptions({ ...base, valueType: 'boolean' })).toStrictEqual(['true', 'false']);
    expect(selectOptions({ ...base, kind: 'env', valueType: 'boolean' })).toStrictEqual([
      '1',
      '0',
      'true',
      'false',
    ]);
    expect(selectOptions({ ...base, valueType: 'enum', allowed: ['x'] })).toStrictEqual(['x']);
  });

  it('starts an unset env switch on 1 and keeps its own spelling', () => {
    const definition: KnobDefinition = { ...base, kind: 'env', valueType: 'boolean' };
    expect(startText(definition)).toBe('1');
    expect(startText(definition, effective('false'))).toBe('false');
  });

  it('starts on the value the chosen layer holds, else the effective value', () => {
    const value: EffectiveValue = {
      key: 'k',
      value: 'top',
      layer: 'project',
      chain: [
        { layer: 'project', value: 'top', file: null },
        { layer: 'user', value: 'mine', file: null },
      ],
    };
    expect(startTextAt(base, value, 'user')).toBe('mine');
    expect(startTextAt(base, value, 'project-local')).toBe('top');
    expect(startTextAt({ ...base, defaultValue: 'd' }, undefined, 'user')).toBe('d');
    const object = { ...value, value: { a: 1 } };
    expect(startTextAt({ ...base, valueType: 'json' }, object, 'project-local')).toBe('');
  });

  it('starts on the winning layer when Overlord can write it', () => {
    expect(defaultLayer()).toBe('user');
    expect(defaultLayer({ ...effective(1), layer: 'project-local' })).toBe('project-local');
    expect(defaultLayer({ ...effective(1), layer: 'managed' })).toBe('user');
    expect(defaultLayer({ ...effective(1), layer: 'env' })).toBe('user');
    expect(defaultLayer({ ...effective(1), layer: 'project-local' }, ['user', 'project'])).toBe(
      'user',
    );
    expect(defaultLayer(undefined, ['project'])).toBe('project');
  });

  it('writes env values as checked strings and settings as typed values', () => {
    const env: KnobDefinition = { ...base, kind: 'env', valueType: 'number' };
    expect(parseKnobValue(env, ' 12 ')).toStrictEqual({ ok: true, value: '12' });
    expect(parseKnobValue(env, 'x')).toStrictEqual({ ok: false, error: 'Enter a number.' });
    expect(parseKnobValue({ ...base, valueType: 'number' }, '12')).toStrictEqual({
      ok: true,
      value: 12,
    });
  });

  it('never puts the redaction mask in the editor or back in a file', () => {
    expect(editorText('string', '<redacted>')).toBe('');
    expect(parseKnobValue({ ...base, valueType: 'json' }, '{"KEY":"<redacted>"}')).toStrictEqual({
      ok: false,
      error: 'Replace <redacted> with the real value, or edit the file.',
    });
  });
});

describe('env and args', () => {
  it('parses KEY=VALUE lines and skips lines without a key', () => {
    expect(parseEnv('A=1\n B = two \n=skip\n\nFLAG\nURL=a=b')).toStrictEqual({
      A: '1',
      B: 'two',
      FLAG: '',
      URL: 'a=b',
    });
  });

  it('formats env back to lines', () => {
    expect(formatEnv({ A: '1', B: 'two' })).toBe('A=1\nB=two');
    expect(formatEnv({})).toBe('');
  });

  it('splits args on any whitespace', () => {
    expect(parseArgs('  --verbose   --debug\tx ')).toStrictEqual(['--verbose', '--debug', 'x']);
    expect(parseArgs('')).toStrictEqual([]);
  });

  it('treats blank text as not set', () => {
    expect(nullIfEmpty('  ')).toBeNull();
    expect(nullIfEmpty(' opus ')).toBe('opus');
  });
});

describe('guards', () => {
  it('knows editable layers', () => {
    expect(isEditableLayer('project-local')).toBe(true);
    expect(isEditableLayer('managed')).toBe(false);
  });
});

describe('areaNames', () => {
  it("keeps Claude Code's words and gives another agent its own", () => {
    expect(areaNames(null)('memory').title).toBe('Memory and CLAUDE.md');
    expect(areaNames(null)('auth').summary).toContain('Bedrock');
    const copilot = areaNames('.github/copilot-instructions.md');
    expect(copilot('memory')).toStrictEqual({
      title: 'Memory and copilot-instructions.md',
      summary: 'Memory and the copilot-instructions.md files it reads.',
    });
    expect(copilot('auth').summary).not.toContain('Bedrock');
    expect(copilot('network')).toStrictEqual(areaNames(null)('network'));
    expect(copilot('custom')).toStrictEqual({ title: 'custom', summary: '' });
  });
});
