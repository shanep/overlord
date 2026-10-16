import { describe, expect, it } from 'vitest';

import type { EffectiveValue, KnobDefinition } from '../../../src/shared/model.js';
import { knobDefinitions } from '../../test/fixtures-context.js';

import {
  displayValue,
  editorText,
  formatEnv,
  groupByArea,
  isEditableLayer,
  isPermissionMode,
  matchesQuery,
  nullIfEmpty,
  parseArgs,
  parseEnv,
  parseKnobInput,
  splitList,
  startText,
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

describe('matchesQuery and groupByArea', () => {
  it('matches key, description or area without case', () => {
    expect(matchesQuery(base, '')).toBe(true);
    expect(matchesQuery(base, ' KNOB ')).toBe(true);
    expect(matchesQuery(base, 'MISC')).toBe(true);
    expect(matchesQuery(base, 'k')).toBe(true);
    expect(matchesQuery(base, 'zzz')).toBe(false);
  });

  it('groups by area with areas and keys sorted', () => {
    const groups = groupByArea(knobDefinitions, '');
    expect(groups.map((group) => group.area)).toStrictEqual([
      'bash',
      'model',
      'permissions',
      'thinking',
    ]);
    expect(groups[1]?.knobs.map((knob) => knob.key)).toStrictEqual(['env', 'model']);
    expect(groups[2]?.knobs.map((knob) => knob.key)).toStrictEqual([
      'additionalDirectories',
      'permissions.defaultMode',
    ]);
  });

  it('drops areas with no match', () => {
    expect(groupByArea(knobDefinitions, 'shell').map((group) => group.area)).toStrictEqual([
      'bash',
    ]);
    expect(groupByArea(knobDefinitions, 'nothing here')).toStrictEqual([]);
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
  it('knows editable layers and permission modes', () => {
    expect(isEditableLayer('project-local')).toBe(true);
    expect(isEditableLayer('managed')).toBe(false);
    expect(isPermissionMode('plan')).toBe(true);
    expect(isPermissionMode('yolo')).toBe(false);
  });
});
