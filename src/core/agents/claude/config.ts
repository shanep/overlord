// Claude Code's config facet, knobs part: the settings layers and files that
// settings.md documents, the knob catalog, and how a profile reaches a launch.
// MCP and the skill and agent folders have their own parts, and sync adds
// its part here later.

import path from 'node:path';

import { loadCatalog } from '../../knobs/catalog.js';
import type { KnobsFacet, LayerSource, SettingsPlace } from '../../knobs/facet.js';
import { toLaunchOptions } from '../../knobs/launch.js';
import type { ConfigFacet } from '../types.js';

import { claudeLibrary } from './library.js';
import { claudeMcp } from './mcp.js';

function projectFile(name: string): (place: SettingsPlace) => string | null {
  return ({ projectDir }) => (projectDir === null ? null : path.join(projectDir, '.claude', name));
}

/** managed > cli > project-local > project > user > env, as settings.md documents. */
const LAYERS: readonly LayerSource[] = [
  {
    kind: 'file',
    layer: 'managed',
    format: 'json',
    file: ({ paths }) => path.join(paths.managedDir, 'managed-settings.json'),
    writable: false,
  },
  { kind: 'cli', layer: 'cli' },
  {
    kind: 'file',
    layer: 'project-local',
    format: 'json',
    file: projectFile('settings.local.json'),
    writable: true,
  },
  {
    kind: 'file',
    layer: 'project',
    format: 'json',
    file: projectFile('settings.json'),
    writable: true,
  },
  {
    kind: 'file',
    layer: 'user',
    format: 'json',
    file: ({ paths }) => paths.userSettings,
    writable: true,
  },
  { kind: 'env', layer: 'env' },
];

/**
 * List keys that settings.md says do not merge: fallbackModel is an ordered
 * chain and modelPicker rows come from one source, so the highest layer wins.
 */
function neverMerges(key: string): boolean {
  return key === 'fallbackModel' || key === 'modelPicker' || key.startsWith('modelPicker.');
}

export const claudeKnobs: KnobsFacet = {
  catalog: loadCatalog,
  layers: LAYERS,
  // Variables Overlord shows even when the catalog does not list them.
  envPrefix: /^(?:ANTHROPIC|CLAUDE|OTEL)_/u,
  envBlock: 'env',
  neverMerges,
  // A managed availableModels list applies as is, with no entries added from lower layers.
  managedReplaces: new Set(['availableModels']),
  // The Agent SDK and the CLI both take the profile's flags and env as they are.
  launchOverrides: toLaunchOptions,
};

export const claudeConfig: ConfigFacet = {
  settingsFormat: 'json',
  knobs: claudeKnobs,
  mcp: claudeMcp,
  library: claudeLibrary,
};
