import { describe, expect, it } from 'vitest';

import { KNOB_AREAS } from '../../shared/knob-areas.js';
import type { KnobDefinition } from '../../shared/model.js';

import {
  catalogAreas,
  catalogEnvKeys,
  filterCatalog,
  findKnob,
  loadCatalog,
  parseCatalog,
} from './catalog.js';

function knob(partial: Partial<KnobDefinition> & Pick<KnobDefinition, 'key'>): KnobDefinition {
  return {
    kind: 'setting',
    area: 'other',
    valueType: 'string',
    defaultValue: null,
    allowed: [],
    description: '',
    docUrl: 'https://code.claude.com/docs/en/x',
    appliesAt: 'next-launch',
    managedOnly: false,
    ...partial,
  };
}

const SAMPLE: readonly KnobDefinition[] = [
  knob({ key: 'model', area: 'model', description: 'Change the model Claude starts with' }),
  knob({ key: 'ANTHROPIC_MODEL', kind: 'env', area: 'model', description: 'Model override' }),
  knob({ key: 'BASH_MAX_OUTPUT_LENGTH', kind: 'env', area: 'bash', description: 'Cap output' }),
  knob({ key: '--verbose', kind: 'flag', area: 'ui', description: 'Show full turn output' }),
];

function countKind(catalog: readonly KnobDefinition[], kind: KnobDefinition['kind']): number {
  return catalog.filter((item) => item.kind === kind).length;
}

describe('loadCatalog', () => {
  const catalog = loadCatalog();

  it('validates the generated catalog once and reuses it', () => {
    expect(loadCatalog()).toBe(catalog);
  });

  it('holds well over a hundred env vars and settings, and the CLI flags', () => {
    expect(countKind(catalog, 'env')).toBeGreaterThan(150);
    expect(countKind(catalog, 'setting')).toBeGreaterThan(100);
    expect(countKind(catalog, 'flag')).toBeGreaterThan(30);
  });

  it('includes the knobs PLAN.md names', () => {
    for (const key of [
      'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
      'BASH_MAX_OUTPUT_LENGTH',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    ]) {
      expect(findKnob(catalog, 'env', key)?.key).toBe(key);
    }
    expect(findKnob(catalog, 'setting', 'model')?.appliesAt).toBe('live');
    expect(findKnob(catalog, 'setting', 'permissions.defaultMode')?.appliesAt).toBe('live');
    expect(findKnob(catalog, 'flag', '--model')?.appliesAt).toBe('next-launch');
  });

  it('is sorted by kind then key with no duplicates', () => {
    const ids = catalog.map((item) => `${item.kind} ${item.key}`);
    expect(ids).toStrictEqual([...ids].toSorted((left, right) => (left < right ? -1 : 1)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses known areas, docs links and no em or en dashes', () => {
    const areas: readonly string[] = KNOB_AREAS;
    const dashes = [String.fromCodePoint(0x20_13), String.fromCodePoint(0x20_14)];
    for (const item of catalog) {
      expect(areas).toContain(item.area);
      expect(item.docUrl.startsWith('https://code.claude.com/docs/en/')).toBe(true);
      expect(dashes.some((dash) => item.description.includes(dash))).toBe(false);
    }
  });
});

describe('parseCatalog', () => {
  it('accepts valid records', () => {
    expect(parseCatalog(SAMPLE)).toStrictEqual(SAMPLE);
    expect(parseCatalog([])).toStrictEqual([]);
  });

  it.each([
    ['a non-array', { key: 'x' }],
    ['an empty key', [{ ...SAMPLE[0], key: '' }]],
    ['an unknown kind', [{ ...SAMPLE[0], kind: 'secret' }]],
    ['an unknown value type', [{ ...SAMPLE[0], valueType: 'date' }]],
    ['a bad doc URL', [{ ...SAMPLE[0], docUrl: 'not a url' }]],
    ['an unknown appliesAt', [{ ...SAMPLE[0], appliesAt: 'someday' }]],
    ['a missing field', [{ key: 'x', kind: 'env' }]],
    ['an empty area', [{ ...SAMPLE[0], area: '' }]],
    ['a non-string default', [{ ...SAMPLE[0], defaultValue: 5 }]],
    ['non-string allowed values', [{ ...SAMPLE[0], allowed: [1] }]],
    ['a non-boolean managedOnly', [{ ...SAMPLE[0], managedOnly: 'no' }]],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseCatalog(raw)).toThrow();
  });
});

describe('filterCatalog', () => {
  it('returns everything for an empty filter', () => {
    expect(filterCatalog(SAMPLE, {})).toStrictEqual(SAMPLE);
    expect(filterCatalog(SAMPLE, { text: ' '.repeat(3), area: null, kind: null })).toStrictEqual(
      SAMPLE,
    );
  });

  it('matches every word against key, description and area, ignoring case', () => {
    expect(filterCatalog(SAMPLE, { text: 'MODEL' }).map((item) => item.key)).toStrictEqual([
      'model',
      'ANTHROPIC_MODEL',
    ]);
    expect(filterCatalog(SAMPLE, { text: 'model claude' }).map((item) => item.key)).toStrictEqual([
      'model',
    ]);
    expect(filterCatalog(SAMPLE, { text: 'cap' }).map((item) => item.key)).toStrictEqual([
      'BASH_MAX_OUTPUT_LENGTH',
    ]);
    expect(filterCatalog(SAMPLE, { text: 'ui' }).map((item) => item.key)).toStrictEqual([
      '--verbose',
    ]);
    expect(filterCatalog(SAMPLE, { text: 'nothing-like-this' })).toStrictEqual([]);
  });

  it('filters by area and kind', () => {
    expect(filterCatalog(SAMPLE, { area: 'model' }).map((item) => item.key)).toStrictEqual([
      'model',
      'ANTHROPIC_MODEL',
    ]);
    expect(filterCatalog(SAMPLE, { kind: 'env' }).map((item) => item.key)).toStrictEqual([
      'ANTHROPIC_MODEL',
      'BASH_MAX_OUTPUT_LENGTH',
    ]);
    expect(
      filterCatalog(SAMPLE, { area: 'model', kind: 'env', text: 'override' }).map(
        (item) => item.key,
      ),
    ).toStrictEqual(['ANTHROPIC_MODEL']);
    expect(filterCatalog(SAMPLE, { area: 'bash', kind: 'flag' })).toStrictEqual([]);
  });
});

describe('catalogAreas', () => {
  it('lists present areas in display order with unknown ones sorted last', () => {
    const areas = catalogAreas([
      ...SAMPLE,
      knob({ key: 'z', area: 'zeta' }),
      knob({ key: 'y', area: 'alpha' }),
      knob({ key: 'w', area: 'model' }),
    ]);
    expect(areas).toStrictEqual(['model', 'bash', 'ui', 'alpha', 'zeta']);
    expect(catalogAreas([])).toStrictEqual([]);
  });
});

describe('findKnob', () => {
  it('matches kind and key', () => {
    expect(findKnob(SAMPLE, 'env', 'ANTHROPIC_MODEL')).toBe(SAMPLE[1]);
    expect(findKnob(SAMPLE, 'setting', 'ANTHROPIC_MODEL')).toBeUndefined();
    expect(findKnob(SAMPLE, 'env', 'model')).toBeUndefined();
  });
});

describe('catalogEnvKeys', () => {
  it('collects the env var names only', () => {
    expect([...catalogEnvKeys(SAMPLE)]).toStrictEqual([
      'ANTHROPIC_MODEL',
      'BASH_MAX_OUTPUT_LENGTH',
    ]);
  });
});
