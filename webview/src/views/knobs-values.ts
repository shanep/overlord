// Pure helpers for the knobs view: grouping, display text, and parsing what
// the user typed into a value of the knob's type.

import type {
  AppliesAt,
  EffectiveValue,
  KnobDefinition,
  KnobValueType,
  PermissionMode,
} from '../../../src/shared/model.js';
import { formatValue } from '../format.js';
import { isStringArray } from '../guards.js';

export type EditableLayer = 'user' | 'project' | 'project-local';

export const EDITABLE_LAYERS: readonly EditableLayer[] = ['user', 'project', 'project-local'];

const LAYER_SET: ReadonlySet<string> = new Set(EDITABLE_LAYERS);

export function isEditableLayer(value: string): value is EditableLayer {
  return LAYER_SET.has(value);
}

export const APPLIES_LABELS: Readonly<Record<AppliesAt, string>> = {
  live: 'live',
  'next-turn': 'next turn',
  'next-launch': 'next launch',
};

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'manual',
];

const MODE_SET: ReadonlySet<string> = new Set(PERMISSION_MODES);

export function isPermissionMode(value: string): value is PermissionMode {
  return MODE_SET.has(value);
}

export type ParseResult =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** Split comma separated text into trimmed, non empty items. */
export function splitList(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function parseJson(text: string): ParseResult {
  try {
    const parsed: unknown = JSON.parse(text);
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
}

function parseNumber(text: string): ParseResult {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(value)) {
    return { ok: false, error: 'Enter a number.' };
  }
  return { ok: true, value };
}

/** Turn editor text into a value of `valueType`, or say why it cannot. */
export function parseKnobInput(valueType: KnobValueType, text: string): ParseResult {
  switch (valueType) {
    case 'boolean': {
      return { ok: true, value: text === 'true' };
    }
    case 'number': {
      return parseNumber(text);
    }
    case 'json': {
      return parseJson(text);
    }
    case 'string[]': {
      return { ok: true, value: splitList(text) };
    }
    case 'string':
    case 'enum': {
      return { ok: true, value: text };
    }
  }
}

/** Editor text for an existing value of `valueType`. */
export function editorText(valueType: KnobValueType, value?: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (valueType === 'string[]' && isStringArray(value)) {
    return value.join(', ');
  }
  if (typeof value === 'string') {
    return value;
  }
  return valueType === 'json' ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** Starting editor text: the effective value, else the default, kept valid for selects. */
export function startText(definition: KnobDefinition, effective?: EffectiveValue): string {
  const text =
    effective === undefined
      ? (definition.defaultValue ?? '')
      : editorText(definition.valueType, effective.value);
  if (definition.valueType === 'boolean') {
    return text === 'true' ? 'true' : 'false';
  }
  if (definition.valueType === 'enum' && !definition.allowed.includes(text)) {
    return definition.allowed[0] ?? '';
  }
  return text;
}

/** What the row shows as the current value. */
export function displayValue(definition: KnobDefinition, effective?: EffectiveValue): string {
  if (effective !== undefined) {
    return formatValue(effective.value);
  }
  return definition.defaultValue === null ? 'unset' : `${definition.defaultValue} (default)`;
}

export interface AreaGroup {
  readonly area: string;
  readonly knobs: readonly KnobDefinition[];
}

export function matchesQuery(definition: KnobDefinition, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return [definition.key, definition.description, definition.area].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/** Knobs matching `query`, grouped by area. Areas and keys sort by name. */
export function groupByArea(catalog: readonly KnobDefinition[], query: string): AreaGroup[] {
  const groups = new Map<string, KnobDefinition[]>();
  for (const definition of catalog) {
    if (matchesQuery(definition, query)) {
      const list = groups.get(definition.area) ?? [];
      list.push(definition);
      groups.set(definition.area, list);
    }
  }
  return [...groups.entries()]
    .toSorted((a, b) => a[0].localeCompare(b[0]))
    .map(([area, knobs]) => ({
      area,
      knobs: knobs.toSorted((a, b) => a.key.localeCompare(b.key)),
    }));
}

/** KEY=VALUE lines into a record. Lines without a key are dropped. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    const key = (index === -1 ? line : line.slice(0, index)).trim();
    if (key !== '') {
      env[key] = index === -1 ? '' : line.slice(index + 1).trim();
    }
  }
  return env;
}

export function formatEnv(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/** Space separated arguments into a list. */
export function parseArgs(text: string): string[] {
  return text.split(/\s+/).filter((argument) => argument !== '');
}

/** Empty text means "not set". */
export function nullIfEmpty(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}
