// Pure helpers for the knobs view: grouping, display text, and parsing what
// the user typed into a value of the knob's type.

import { isKnobArea, KNOB_AREA_INFO, KNOB_AREAS } from '../../../src/shared/knob-areas.js';
import type {
  AppliesAt,
  EffectiveValue,
  KnobDefinition,
  KnobKind,
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

/** What the host sends in place of a secret env var's value. */
const REDACTED = '<redacted>';

/** Values the editor starts empty on. */
const NO_TEXT: ReadonlySet<unknown> = new Set([undefined, null, REDACTED]);

/** Editor text for an existing value of `valueType`. Secrets start empty, never as the mask. */
export function editorText(valueType: KnobValueType, value?: unknown): string {
  if (NO_TEXT.has(value)) {
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

/** Env vars hold strings, and the docs use both spellings for on and off. */
const ENV_BOOLEAN_OPTIONS: readonly string[] = ['1', '0', 'true', 'false'];

/** The choices a select offers for a boolean or enum knob. */
export function selectOptions(definition: KnobDefinition): readonly string[] {
  if (definition.valueType === 'enum') {
    return definition.allowed;
  }
  return definition.kind === 'env' ? ENV_BOOLEAN_OPTIONS : ['true', 'false'];
}

/** Starting editor text: the effective value, else the default, kept valid for selects. */
export function startText(definition: KnobDefinition, effective?: EffectiveValue): string {
  const text =
    effective === undefined
      ? (definition.defaultValue ?? '')
      : editorText(definition.valueType, effective.value);
  if (definition.valueType === 'boolean' || definition.valueType === 'enum') {
    const options = selectOptions(definition);
    // An unset setting switch starts off; an env var is usually set to turn something on.
    const fallback =
      definition.valueType === 'boolean' && definition.kind !== 'env' ? 'false' : options[0];
    return options.includes(text) ? text : (fallback ?? '');
  }
  return text;
}

/** Starting editor text for one layer: what that layer holds, else the effective value. */
export function startTextAt(
  definition: KnobDefinition,
  effective: EffectiveValue | undefined,
  layer: EditableLayer,
): string {
  const link = effective?.chain.find((item) => item.layer === layer);
  if (link === undefined || effective === undefined) {
    // An object can merge values from other layers and the process env, which must not be
    // copied into this layer's file, so it starts from the default instead.
    return startText(definition, definition.valueType === 'json' ? undefined : effective);
  }
  return startText(definition, { ...effective, value: link.value });
}

/** The layer the editor starts on: the one that sets the value now, when Overlord can write it. */
export function defaultLayer(effective?: EffectiveValue): EditableLayer {
  const layer = effective?.layer;
  return layer !== undefined && isEditableLayer(layer) ? layer : 'user';
}

/**
 * The value to write for a knob. Env vars are always written as strings, since
 * Claude Code passes them to the process environment, but are still checked
 * against their documented type.
 */
export function parseKnobValue(definition: KnobDefinition, text: string): ParseResult {
  if (definition.kind !== 'env') {
    const parsed = parseKnobInput(definition.valueType, text);
    return parsed.ok && JSON.stringify(parsed.value).includes(JSON.stringify(REDACTED))
      ? { ok: false, error: `Replace ${REDACTED} with the real value, or edit the file.` }
      : parsed;
  }
  const checked = parseKnobInput(definition.valueType, text);
  return checked.ok ? { ok: true, value: text.trim() } : checked;
}

/** What the row shows as the current value. */
export function displayValue(definition: KnobDefinition, effective?: EffectiveValue): string {
  if (effective !== undefined) {
    return formatValue(effective.value);
  }
  return definition.defaultValue === null ? 'unset' : `${definition.defaultValue} (default)`;
}

export type KindFilter = 'all' | KnobKind;

export const KIND_FILTERS: readonly { readonly value: KindFilter; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'setting', label: 'Settings' },
  { value: 'env', label: 'Env vars' },
  { value: 'flag', label: 'CLI flags' },
];

const KIND_FILTER_SET: ReadonlySet<string> = new Set(KIND_FILTERS.map((item) => item.value));

export function isKindFilter(value: unknown): value is KindFilter {
  return typeof value === 'string' && KIND_FILTER_SET.has(value);
}

export interface KnobFilter {
  readonly query: string;
  readonly kind: KindFilter;
  /** Only knobs some layer sets, or CLI flags some launch profile passes. */
  readonly onlySet: boolean;
  /** Include keys the docs mark removed or deprecated. */
  readonly showRetired: boolean;
}

export interface KnobEntry {
  readonly definition: KnobDefinition;
  readonly effective: EffectiveValue | undefined;
  /** For CLI flags, the launch profiles that pass it. */
  readonly profiles: readonly string[];
}

export interface AreaGroup {
  readonly area: string;
  readonly title: string;
  readonly summary: string;
  readonly entries: readonly KnobEntry[];
  readonly setCount: number;
}

const RETIRED = /^(?:removed in|deprecated)/iu;

/** The docs say the key is gone or on its way out. */
export function isRetired(definition: KnobDefinition): boolean {
  return RETIRED.test(definition.description);
}

export function isSet(entry: KnobEntry): boolean {
  return entry.effective !== undefined || entry.profiles.length > 0;
}

function areaInfo(area: string): { readonly title: string; readonly summary: string } {
  return isKnobArea(area) ? KNOB_AREA_INFO[area] : { title: area, summary: '' };
}

/** True when every word of `query` appears in the key, description or area, any case. */
export function matchesQuery(definition: KnobDefinition, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/u);
  const haystack = [
    definition.key,
    definition.description,
    definition.area,
    areaInfo(definition.area).title,
  ]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

const KIND_ORDER: readonly KnobKind[] = ['setting', 'env', 'flag'];

function compareEntries(left: KnobEntry, right: KnobEntry): number {
  const kind = KIND_ORDER.indexOf(left.definition.kind) - KIND_ORDER.indexOf(right.definition.kind);
  return kind === 0 ? left.definition.key.localeCompare(right.definition.key) : kind;
}

function keep(entry: KnobEntry, filter: KnobFilter): boolean {
  const { definition } = entry;
  return (
    (filter.kind === 'all' || definition.kind === filter.kind) &&
    (filter.showRetired || !isRetired(definition) || isSet(entry)) &&
    (!filter.onlySet || isSet(entry)) &&
    matchesQuery(definition, filter.query)
  );
}

function areaRank(area: string): number {
  return isKnobArea(area) ? KNOB_AREAS.indexOf(area) : KNOB_AREAS.length;
}

/** Entries that pass the filter, grouped by area in the catalog's area order. */
export function groupEntries(entries: readonly KnobEntry[], filter: KnobFilter): AreaGroup[] {
  const groups = new Map<string, KnobEntry[]>();
  for (const entry of entries) {
    if (keep(entry, filter)) {
      const list = groups.get(entry.definition.area) ?? [];
      list.push(entry);
      groups.set(entry.definition.area, list);
    }
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => areaRank(left) - areaRank(right) || left.localeCompare(right))
    .map(([area, list]) => ({
      area,
      ...areaInfo(area),
      entries: list.toSorted(compareEntries),
      setCount: list.filter((entry) => isSet(entry)).length,
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
