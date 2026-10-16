// Pure helpers that tie catalog knobs to what is actually set: the effective
// value for each knob (env vars live under env., object settings may be set
// one child at a time), the keys no catalog entry covers, and CLI flags kept
// in launch profiles.

import type {
  EffectiveValue,
  KnobDefinition,
  LaunchProfile,
  SettingsLayer,
} from '../../../src/shared/model.js';
import { isRecord } from '../guards.js';

import type { KnobEntry } from './knobs-values.js';

/** Highest precedence first, the same order the host uses. */
const LAYER_ORDER: readonly SettingsLayer[] = [
  'managed',
  'cli',
  'project-local',
  'project',
  'user',
  'env',
  'default',
];

type ChainLink = EffectiveValue['chain'][number];

/** The dotted settings key a knob is stored under, or null for CLI flags. */
export function effectiveKey(definition: KnobDefinition): string | null {
  switch (definition.kind) {
    case 'env': {
      return `env.${definition.key}`;
    }
    case 'setting': {
      return definition.key;
    }
    case 'flag': {
      return null;
    }
  }
}

type Tree = Record<string, unknown>;

/** Set `value` at a dotted path inside `tree`, creating objects on the way. */
function assignPath(tree: Tree, path: string, value: unknown): void {
  const dot = path.lastIndexOf('.');
  const parents = dot === -1 ? [] : path.slice(0, dot).split('.');
  let node = tree;
  for (const segment of parents) {
    const child = node[segment];
    const next: Tree = isRecord(child) ? { ...child } : {};
    node[segment] = next;
    node = next;
  }
  node[path.slice(dot + 1)] = value;
}

/** One value for an object setting whose children are set as separate dotted keys. */
function composeChildren(key: string, children: readonly EffectiveValue[]): EffectiveValue {
  const value: Tree = {};
  const perLayer = new Map<SettingsLayer, { tree: Tree; file: string | null }>();
  for (const child of children) {
    const suffix = child.key.slice(key.length + 1);
    assignPath(value, suffix, child.value);
    for (const link of child.chain) {
      const entry = perLayer.get(link.layer) ?? { tree: {}, file: link.file };
      assignPath(entry.tree, suffix, link.value);
      perLayer.set(link.layer, entry);
    }
  }
  const chain: ChainLink[] = LAYER_ORDER.flatMap((layer) => {
    const entry = perLayer.get(layer);
    return entry === undefined ? [] : [{ layer, value: entry.tree, file: entry.file }];
  });
  return { key, value, layer: chain[0]?.layer ?? 'default', chain };
}

/** Effective values by dotted key, built once per render. */
export interface EffectiveIndex {
  readonly byKey: ReadonlyMap<string, EffectiveValue>;
  readonly all: readonly EffectiveValue[];
}

export function indexEffective(effective: readonly EffectiveValue[]): EffectiveIndex {
  return { byKey: new Map(effective.map((value) => [value.key, value])), all: effective };
}

/** What is set for a knob, or undefined when no layer sets it. */
export function effectiveFor(
  definition: KnobDefinition,
  index: EffectiveIndex,
): EffectiveValue | undefined {
  const key = effectiveKey(definition);
  if (key === null) {
    return undefined;
  }
  const exact = index.byKey.get(key);
  if (exact !== undefined || definition.kind !== 'setting') {
    return exact;
  }
  const prefix = `${key}.`;
  const children = index.all.filter((value) => value.key.startsWith(prefix));
  return children.length === 0 ? undefined : composeChildren(key, children);
}

function coveredBy(
  key: string,
  settings: readonly string[],
  envKeys: ReadonlySet<string>,
): boolean {
  if (key.startsWith('env.')) {
    // The env setting itself would cover every variable, so only a catalog env var counts.
    return envKeys.has(key.slice(4));
  }
  return settings.some((setting) => key === setting || key.startsWith(`${setting}.`));
}

/** Set keys that no catalog knob covers, such as your own env vars. */
export function unlistedEffective(
  catalog: readonly KnobDefinition[],
  effective: readonly EffectiveValue[],
): readonly EffectiveValue[] {
  const settings = catalog.filter((knob) => knob.kind === 'setting').map((knob) => knob.key);
  const envKeys = new Set(catalog.filter((knob) => knob.kind === 'env').map((knob) => knob.key));
  return effective.filter((value) => !coveredBy(value.key, settings, envKeys));
}

const PLAIN_TYPES: ReadonlyMap<string, KnobDefinition['valueType']> = new Map([
  ['boolean', 'boolean'],
  ['number', 'number'],
  ['string', 'string'],
] as const);

function valueTypeOf(value: unknown): KnobDefinition['valueType'] {
  return PLAIN_TYPES.get(typeof value) ?? 'json';
}

/** A stand-in definition so an unlisted key can use the same row and editor. */
export function unlistedDefinition(value: EffectiveValue): KnobDefinition {
  return {
    key: value.key,
    kind: 'setting',
    area: 'other',
    valueType: valueTypeOf(value.value),
    defaultValue: null,
    allowed: [],
    description: value.key.startsWith('env.')
      ? 'An env var the docs do not list.'
      : 'A key the docs do not list.',
    docUrl: '',
    appliesAt: 'next-launch',
    managedOnly: false,
  };
}

// ---- CLI flags in launch profiles --------------------------------------

function isFlagToken(token: string, flag: string): boolean {
  return token === flag || token.startsWith(`${flag}=`);
}

/** The flag's value in a profile: null when the flag is bare, undefined when it is absent. */
export function flagInProfile(profile: LaunchProfile, flag: string): string | null | undefined {
  const args = profile.extraArgs;
  const found = args.find((token) => isFlagToken(token, flag));
  if (found === undefined) {
    return undefined;
  }
  const index = args.indexOf(found);
  if (found.startsWith(`${flag}=`)) {
    return found.slice(flag.length + 1);
  }
  const next = args[index + 1];
  return next === undefined || next.startsWith('-') ? null : next;
}

/** The profile's args without `flag`, and without the value token that followed it. */
export function withoutFlag(args: readonly string[], flag: string): readonly string[] {
  const out: string[] = [];
  let skipValue = false;
  for (const token of args) {
    if (skipValue && !token.startsWith('-')) {
      skipValue = false;
      continue;
    }
    skipValue = false;
    if (isFlagToken(token, flag)) {
      skipValue = token === flag;
      continue;
    }
    out.push(token);
  }
  return out;
}

/** The profile's args with `flag` set, replacing any earlier copy. Null value means a bare flag. */
export function withFlag(
  args: readonly string[],
  flag: string,
  value: string | null,
): readonly string[] {
  const token = value === null ? flag : `${flag}=${value}`;
  return [...withoutFlag(args, flag), token];
}

/** Names of the profiles that pass this flag. */
export function profilesWithFlag(
  profiles: readonly LaunchProfile[],
  flag: string,
): readonly string[] {
  return profiles
    .filter((profile) => flagInProfile(profile, flag) !== undefined)
    .map((profile) => profile.name);
}

/** Each catalog knob with what is set for it. */
export function knobEntries(
  catalog: readonly KnobDefinition[],
  effective: readonly EffectiveValue[],
  profiles: readonly LaunchProfile[],
): readonly KnobEntry[] {
  const index = indexEffective(effective);
  return catalog.map((definition) => ({
    definition,
    effective: effectiveFor(definition, index),
    profiles: definition.kind === 'flag' ? profilesWithFlag(profiles, definition.key) : [],
  }));
}
