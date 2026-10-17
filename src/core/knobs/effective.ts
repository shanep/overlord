// The effective value of every settings key, with provenance. Precedence and
// which list keys merge across layers instead of overriding come from the
// agent's config facet.

import type { EffectiveValue, SettingsLayer } from '../../shared/model.js';

import type { KnobsFacet } from './facet.js';
import { isArray, isPlainObject, type JsonRecord } from './json.js';
import type { LayerData } from './layers.js';

/** What computeEffective needs from a facet. */
type MergeRules = Pick<KnobsFacet, 'layers' | 'neverMerges' | 'managedReplaces'>;

/** The facet's layers, highest precedence first, then built-in defaults. */
export function layerOrder(rules: Pick<KnobsFacet, 'layers'>): readonly SettingsLayer[] {
  return [...rules.layers.map((source) => source.layer), 'default'];
}

/** Env var names whose values never leave the extension host. */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|AUTH|HEADERS|COOKIE/iu;

export const REDACTED = '<redacted>';

function flattenInto(prefix: string, values: JsonRecord, out: Map<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    const dotted = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      flattenInto(dotted, value, out);
    } else {
      out.set(dotted, value);
    }
  }
}

/**
 * Flatten nested objects into dotted keys (permissions.allow). Arrays and
 * empty objects stay whole values.
 */
export function flattenSettings(values: JsonRecord): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>();
  flattenInto('', values, out);
  return out;
}

export function isSecretKey(key: string): boolean {
  return key.startsWith('env.') && SECRET_ENV.test(key.slice(4));
}

type ChainLink = EffectiveValue['chain'][number];

function mergeArrays(chain: readonly ChainLink[]): readonly unknown[] {
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const link of chain) {
    const items = isArray(link.value) ? link.value : [];
    for (const item of items) {
      const id = JSON.stringify(item);
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(item);
      }
    }
  }
  return merged;
}

function resolveValue(
  key: string,
  chain: readonly ChainLink[],
  winner: ChainLink,
  rules: MergeRules,
): unknown {
  if (!isArray(winner.value) || rules.neverMerges(key)) {
    return winner.value;
  }
  if (winner.layer === 'managed' && rules.managedReplaces.has(key)) {
    return winner.value;
  }
  return mergeArrays(chain);
}

function redactChain(chain: readonly ChainLink[]): readonly ChainLink[] {
  return chain.map((link) => ({ ...link, value: REDACTED }));
}

/** Keys in the map are unique, so two keys never compare equal. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : 1;
}

interface KeyChain {
  readonly winner: ChainLink;
  readonly links: ChainLink[];
}

/** One EffectiveValue per dotted key set in any layer, sorted by key. */
export function computeEffective(
  layers: readonly LayerData[],
  rules: MergeRules,
): readonly EffectiveValue[] {
  const order = layerOrder(rules);
  const rank = (layer: SettingsLayer): number => order.indexOf(layer);
  const ordered = layers.toSorted((left, right) => rank(left.layer) - rank(right.layer));
  const chains = new Map<string, KeyChain>();
  for (const layer of ordered) {
    for (const [key, value] of flattenSettings(layer.values)) {
      const link: ChainLink = { layer: layer.layer, value, file: layer.file };
      const existing = chains.get(key);
      if (existing === undefined) {
        chains.set(key, { winner: link, links: [link] });
      } else {
        existing.links.push(link);
      }
    }
  }
  return [...chains.entries()]
    .toSorted(([left], [right]) => compareKeys(left, right))
    .map(([key, { winner, links }]) => {
      const secret = isSecretKey(key);
      return {
        key,
        value: secret ? REDACTED : resolveValue(key, links, winner, rules),
        layer: winner.layer,
        chain: secret ? redactChain(links) : links,
      };
    });
}
