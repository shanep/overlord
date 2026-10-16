// The knob catalog: every documented settings key, env var and CLI flag.
// The data comes from catalog.generated.json (npm run catalog) and is checked
// with zod on load, so a bad regeneration fails loudly instead of rendering junk.

import { z } from 'zod';

import type { KnobDefinition, KnobKind } from '../../shared/model.js';

import { KNOB_AREAS } from './areas.js';
import generated from './catalog.generated.json';

const knobSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(['setting', 'env', 'flag']),
  area: z.string().min(1),
  valueType: z.enum(['boolean', 'number', 'string', 'enum', 'json', 'string[]']),
  defaultValue: z.string().nullable(),
  allowed: z.array(z.string()),
  description: z.string(),
  docUrl: z.url(),
  appliesAt: z.enum(['live', 'next-turn', 'next-launch']),
  managedOnly: z.boolean(),
});

const catalogSchema = z.array(knobSchema);

/** Validate raw catalog data. Throws a ZodError when it does not match. */
export function parseCatalog(raw: unknown): readonly KnobDefinition[] {
  const knobs: readonly KnobDefinition[] = catalogSchema.parse(raw);
  return knobs;
}

let cached: readonly KnobDefinition[] | null = null;

/** The bundled catalog, validated once. */
export function loadCatalog(): readonly KnobDefinition[] {
  cached ??= parseCatalog(generated);
  return cached;
}

export interface CatalogFilter {
  /** Words that must all appear in the key, description or area, any case. */
  readonly text?: string | undefined;
  readonly area?: string | null | undefined;
  readonly kind?: KnobKind | null | undefined;
}

function matchesText(knob: KnobDefinition, words: readonly string[]): boolean {
  const haystack = `${knob.key} ${knob.description} ${knob.area}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function filterCatalog(
  catalog: readonly KnobDefinition[],
  filter: CatalogFilter,
): readonly KnobDefinition[] {
  // An empty word matches everything, so no need to drop the ones split leaves.
  const words = (filter.text ?? '').toLowerCase().split(/\s+/u);
  const area = filter.area ?? null;
  const kind = filter.kind ?? null;
  return catalog.filter(
    (knob) =>
      (area === null || knob.area === area) &&
      (kind === null || knob.kind === kind) &&
      matchesText(knob, words),
  );
}

/** The areas that have at least one knob, in the order the Knobs view shows them. */
export function catalogAreas(catalog: readonly KnobDefinition[]): readonly string[] {
  const present = new Set(catalog.map((knob) => knob.area));
  const known: readonly string[] = KNOB_AREAS;
  const extra = [...present]
    .filter((area) => !known.includes(area))
    .toSorted((left, right) => left.localeCompare(right));
  return [...known.filter((area) => present.has(area)), ...extra];
}

export function findKnob(
  catalog: readonly KnobDefinition[],
  kind: KnobKind,
  key: string,
): KnobDefinition | undefined {
  return catalog.find((knob) => knob.kind === kind && knob.key === key);
}

/** Every env var name in the catalog, for picking the process env subset. */
export function catalogEnvKeys(catalog: readonly KnobDefinition[]): ReadonlySet<string> {
  return new Set(catalog.filter((knob) => knob.kind === 'env').map((knob) => knob.key));
}
