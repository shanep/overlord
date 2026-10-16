import { describe, expect, it } from 'vitest';

import type { KnobDefinition, SettingsLayer } from '../../shared/model.js';
import { loadCatalog } from '../knobs/catalog.js';
import type { LayerData } from '../knobs/layers.js';

import { DOCUMENTED_INBOUND, effectiveInbound, INBOUND_KEY, inboundChoices } from './inbound.js';

function layer(name: SettingsLayer, value?: unknown): LayerData {
  return {
    layer: name,
    file: null,
    values: value === undefined ? { other: 1 } : { [INBOUND_KEY]: value },
    error: null,
  };
}

function layerOf(name: string, value: unknown): LayerData {
  const known: readonly SettingsLayer[] = ['managed', 'cli', 'project-local', 'project', 'user'];
  const found = known.find((entry) => entry === name);
  if (found === undefined) {
    throw new Error(`unknown layer ${name}`);
  }
  return layer(found, value);
}

function effective(values: Partial<Record<SettingsLayer, unknown>>): string | null {
  return effectiveInbound(Object.entries(values).map(([name, value]) => layerOf(name, value)));
}

const knob: KnobDefinition = {
  key: INBOUND_KEY,
  kind: 'setting',
  area: 'subagents',
  valueType: 'enum',
  defaultValue: null,
  allowed: ['accept', 'refuse'],
  description: '',
  docUrl: 'https://example.com',
  appliesAt: 'next-launch',
  managedOnly: false,
};

describe('inboundChoices', () => {
  it('uses the catalog list, else the documented values', () => {
    expect(DOCUMENTED_INBOUND).toStrictEqual(['accept', 'hold', 'refuse']);
    expect(inboundChoices(loadCatalog())).toStrictEqual(['accept', 'hold', 'refuse']);
    expect(inboundChoices([knob])).toStrictEqual(['accept', 'refuse']);
    expect(inboundChoices([{ ...knob, allowed: [] }])).toBe(DOCUMENTED_INBOUND);
    expect(inboundChoices([{ ...knob, key: 'other' }])).toBe(DOCUMENTED_INBOUND);
  });
});

describe('effectiveInbound', () => {
  it('is null when nothing sets it', () => {
    expect(effectiveInbound([])).toBeNull();
    expect(effectiveInbound([layer('user'), layer('project')])).toBeNull();
    expect(effective({ user: null })).toBeNull();
  });

  it('takes the first of managed, cli and user', () => {
    expect(effective({ user: 'accept' })).toBe('accept');
    expect(effective({ user: 'refuse', cli: 'hold' })).toBe('hold');
    expect(effective({ user: 'refuse', cli: 'hold', managed: 'accept' })).toBe('accept');
  });

  it('applies a project or local value only when it is stricter', () => {
    expect(effective({ project: 'accept' })).toBeNull();
    expect(effective({ project: 'hold' })).toBe('hold');
    expect(effective({ 'project-local': 'refuse', project: 'hold' })).toBe('refuse');
    expect(effective({ user: 'refuse', project: 'accept' })).toBe('refuse');
    expect(effective({ user: 'accept', project: 'hold' })).toBe('hold');
    expect(effective({ user: 'hold', 'project-local': 'hold' })).toBe('hold');
  });

  it('treats an unknown managed value as refuse', () => {
    expect(effective({ managed: 'sometimes', user: 'accept' })).toBe('refuse');
  });

  it('holds while an unknown value sits in a non-managed file, unless a refuse applies', () => {
    expect(effective({ user: 'maybe' })).toBe('hold');
    expect(effective({ cli: 'maybe', user: 'accept' })).toBe('hold');
    expect(effective({ managed: 'accept', project: 7 })).toBe('hold');
    expect(effective({ user: 'maybe', project: 'refuse' })).toBe('refuse');
    expect(effective({ cli: 'refuse', user: 'maybe' })).toBe('refuse');
  });
});
