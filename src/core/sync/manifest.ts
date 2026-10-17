// overlord.json: the config repo's list of every item and how it lands on disk.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { ConfigKind } from '../../shared/model.js';

import { readTextOrNull } from './files.js';
import { compareStrings, parseJson, stableJson } from './json.js';
import { LAYOUT, repoFile } from './layout.js';

const MANIFEST_VERSION = 1;

export const kindSchema: z.ZodType<ConfigKind> = z.enum([
  'claude-md',
  'settings',
  'rule',
  'skill',
  'agent',
  'command',
  'output-style',
  'hook',
  'mcp-server',
  'plugin',
  'memory',
  'keybindings',
]);

/** A repo relative path that cannot climb out of the repo. */
export function isSafeRepoPath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.includes('\\')) {
    return false;
  }
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** A target under the home directory, written as ~/..., that cannot climb out of it. */
export function isSafeHomeTarget(value: string): boolean {
  return value.startsWith('~/') && isSafeRepoPath(value.slice(2));
}

const repoPath = z
  .string()
  .refine(isSafeRepoPath, { error: 'must be a relative path in the repo' });
const homeTarget = z.string().refine(isSafeHomeTarget, { error: 'must be a path under ~/' });

const manifestItemSchema = z.object({
  id: z.string().min(1),
  kind: kindSchema,
  source: repoPath,
  target: homeTarget,
  mode: z.enum(['link', 'copy', 'generate']),
});

const externalSchema = z.object({
  repoUrl: z.string().min(1),
  /** Path inside the external repo. */
  path: repoPath,
  target: homeTarget,
  /** Where the external repo is cloned. Defaults to ~/repos/<name>. */
  checkout: homeTarget.optional(),
});

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  claudeCodeVersion: z.string().nullable().default(null),
  items: z.array(manifestItemSchema).default([]),
  external: z.array(externalSchema).default([]),
  plugins: z
    .object({
      marketplaces: z
        .array(z.object({ name: z.string().min(1), source: z.string().min(1) }))
        .default([]),
      enabled: z.array(z.string().min(1)).default([]),
    })
    .default({ marketplaces: [], enabled: [] }),
  mcp: repoPath.nullable().default(null),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      keyBy: z.literal('git-remote').default('git-remote'),
    })
    .default({ enabled: true, keyBy: 'git-remote' }),
});

export type Manifest = z.output<typeof manifestSchema>;
export type ManifestItem = z.output<typeof manifestItemSchema>;
export type ExternalItem = z.output<typeof externalSchema>;

export type ManifestResult =
  | { readonly ok: true; readonly manifest: Manifest }
  | { readonly ok: false; readonly error: string };

export function emptyManifest(): Manifest {
  return manifestSchema.parse({ version: MANIFEST_VERSION });
}

export function parseManifest(value: unknown): ManifestResult {
  const result = manifestSchema.safeParse(value);
  if (result.success) {
    return { ok: true, manifest: result.data };
  }
  return { ok: false, error: z.prettifyError(result.error) };
}

export async function readManifest(repoRoot: string): Promise<ManifestResult> {
  const file = repoFile(repoRoot, LAYOUT.manifest);
  const text = await readTextOrNull(file);
  if (text === null) {
    return { ok: false, error: `${LAYOUT.manifest} not found in ${repoRoot}` };
  }
  const value = parseJson(text);
  if (value === undefined) {
    return { ok: false, error: `${LAYOUT.manifest} is not valid JSON` };
  }
  return parseManifest(value);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted(compareStrings);
}

/** The same manifest with every list in a fixed order, so rewrites make small diffs. */
export function normalizeManifest(manifest: Manifest): Manifest {
  return {
    ...manifest,
    items: [...manifest.items].toSorted((a, b) => compareStrings(a.id, b.id)),
    external: [...manifest.external].toSorted((a, b) => compareStrings(a.target, b.target)),
    plugins: {
      marketplaces: [...manifest.plugins.marketplaces].toSorted((a, b) =>
        compareStrings(a.name, b.name),
      ),
      enabled: uniqueSorted(manifest.plugins.enabled),
    },
  };
}

export function serializeManifest(manifest: Manifest): string {
  return stableJson(normalizeManifest(manifest));
}

export async function writeManifest(repoRoot: string, manifest: Manifest): Promise<void> {
  const file = repoFile(repoRoot, LAYOUT.manifest);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serializeManifest(manifest));
}

/** Add items, replacing any with the same id. */
export function upsertItems(manifest: Manifest, items: readonly ManifestItem[]): Manifest {
  const ids = new Set(items.map((item) => item.id));
  const kept = manifest.items.filter((item) => !ids.has(item.id));
  return normalizeManifest({ ...manifest, items: [...kept, ...items] });
}
