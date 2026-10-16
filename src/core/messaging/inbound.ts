// The crossSessionInbound setting: what a session does with messages from
// the user's other sessions. settings-reference.md documents its own
// precedence, which differs from the usual layer order:
//   - managed, then --settings, then user settings: the first value found applies
//   - a project or local value applies only when it is stricter (refuse > hold > accept)
//   - an unrecognized value in a non-managed file holds messages, unless a refuse applies
//   - an unrecognized managed value counts as refuse

import type { KnobDefinition, SettingsLayer } from '../../shared/model.js';
import type { LayerData } from '../knobs/layers.js';

export const INBOUND_KEY = 'crossSessionInbound';

/** The values settings-reference.md lists, least strict first. */
export const DOCUMENTED_INBOUND: readonly string[] = ['accept', 'hold', 'refuse'];

const TRUSTED: readonly SettingsLayer[] = ['managed', 'cli', 'user'];
const PROJECT: readonly SettingsLayer[] = ['project-local', 'project'];

/** The documented values, as the bundled catalog lists them when it has them. */
export function inboundChoices(catalog: readonly KnobDefinition[]): readonly string[] {
  const knob = catalog.find((entry) => entry.key === INBOUND_KEY);
  return knob === undefined || knob.allowed.length === 0 ? DOCUMENTED_INBOUND : knob.allowed;
}

function strictness(value: string | null): number {
  return value === null ? 0 : DOCUMENTED_INBOUND.indexOf(value);
}

function isChoice(value: unknown): value is string {
  return typeof value === 'string' && DOCUMENTED_INBOUND.includes(value);
}

/** The value a layer sets, or undefined when it does not set one (null counts as unset). */
function valueIn(layers: readonly LayerData[], name: SettingsLayer): unknown {
  const values = layers.find((layer) => layer.layer === name)?.values ?? {};
  return Object.hasOwn(values, INBOUND_KEY) ? (values[INBOUND_KEY] ?? undefined) : undefined;
}

interface Resolution {
  readonly value: string | null;
  /** An unrecognized value was found, so messages are held at least. */
  readonly held: boolean;
}

function trustedValue(layers: readonly LayerData[]): Resolution {
  let held = false;
  for (const name of TRUSTED) {
    const value = valueIn(layers, name);
    if (isChoice(value)) {
      return { value, held };
    }
    if (value !== undefined && name === 'managed') {
      return { value: 'refuse', held };
    }
    held ||= value !== undefined;
  }
  return { value: null, held };
}

/** The crossSessionInbound value in effect, or null when none applies and Claude Code decides per message. */
export function effectiveInbound(layers: readonly LayerData[]): string | null {
  const trusted = trustedValue(layers);
  let { value, held } = trusted;
  for (const name of PROJECT) {
    const local = valueIn(layers, name);
    if (isChoice(local)) {
      value = strictness(local) > strictness(value) ? local : value;
    } else {
      held ||= local !== undefined;
    }
  }
  return held && strictness(value) < strictness('hold') ? 'hold' : value;
}
