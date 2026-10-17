// Codex CLI's config facet, knobs part. Codex reads $CODEX_HOME/config.toml,
// and a project's .codex/config.toml once the project is trusted, with the
// project winning. Launches take settings as `-c key=value`, so a profile
// never touches either file. Saving a knob for terminal sessions goes
// through the targeted TOML editor (knobs/toml-edit.ts).

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'smol-toml';

import type { KnobsFacet, LayerSource, SettingsPlace } from '../../knobs/facet.js';

import { codexLaunchOverrides } from './launch.js';
import { codexHome } from './observer.js';

function userFile(place: SettingsPlace): string {
  return path.join(codexHome({ home: place.paths.home, env: place.env }), 'config.toml');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when the user config.toml marks the folder, or one above it, as
 * trusted. Codex writes `[projects."<path>"] trust_level = "trusted"` when
 * the user trusts a project, and skips the project's .codex folder until then.
 */
function isTrusted(userConfig: string, folder: string): boolean {
  let projects: unknown;
  try {
    const parsed: unknown = parse(readFileSync(userConfig, 'utf8'));
    projects = isRecord(parsed) ? parsed['projects'] : undefined;
  } catch {
    return false;
  }
  if (!isRecord(projects)) {
    return false;
  }
  for (let dir = folder; ; dir = path.dirname(dir)) {
    const entry = projects[dir];
    if (isRecord(entry) && entry['trust_level'] === 'trusted') {
      return true;
    }
    if (path.dirname(dir) === dir) {
      return false;
    }
  }
}

/** project > user, as the Codex config docs order the layers. */
const LAYERS: readonly LayerSource[] = [
  { kind: 'cli', layer: 'cli' },
  {
    kind: 'file',
    layer: 'project',
    format: 'toml',
    file: (place) =>
      place.projectDir === null || !isTrusted(userFile(place), place.projectDir)
        ? null
        : path.join(place.projectDir, '.codex', 'config.toml'),
    writable: true,
  },
  { kind: 'file', layer: 'user', format: 'toml', file: userFile, writable: true },
];

export const codexKnobs: KnobsFacet = {
  // Milestone 5 of META-HARNESS.md brings the catalog.
  catalog: () => [],
  layers: LAYERS,
  // Codex takes no env vars from its settings, and shows none past its own.
  envPrefix: null,
  envBlock: null,
  neverMerges: () => true,
  managedReplaces: new Set(),
  launchOverrides: codexLaunchOverrides,
};
