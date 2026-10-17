// Copilot CLI's config facet, knobs part: the settings files the
// configuration directory reference documents, its knob catalog, and how a
// launch profile becomes Copilot's own flags. Settings apply in this order,
// later winning: user ~/.copilot/settings.json, repository
// .github/copilot/settings.json, local .github/copilot/settings.local.json,
// environment variables, then flags. Every file is JSONC. The MDM managed
// settings come from a macOS profile or the Windows registry, not a file
// Overlord can read, so they have no layer here.

import path from 'node:path';

import type { LaunchProfile } from '../../../shared/model.js';
import { bundledCatalog } from '../../knobs/catalog.js';
import copilotCatalog from '../../knobs/catalogs/copilot.json';
import type { KnobsFacet, LaunchOverrides, LayerSource, SettingsPlace } from '../../knobs/facet.js';
import { toExtraArgs } from '../../knobs/launch.js';

import { copilotHome } from './mcp.js';

function repoFile(name: string): (place: SettingsPlace) => string | null {
  return ({ projectDir }) =>
    projectDir === null ? null : path.join(projectDir, '.github', 'copilot', name);
}

/** env > project-local > project > user, highest first, as the reference documents. */
const LAYERS: readonly LayerSource[] = [
  { kind: 'env', layer: 'env' },
  {
    kind: 'file',
    layer: 'project-local',
    format: 'jsonc',
    file: repoFile('settings.local.json'),
    writable: true,
  },
  {
    kind: 'file',
    layer: 'project',
    format: 'jsonc',
    file: repoFile('settings.json'),
    writable: true,
  },
  {
    kind: 'file',
    layer: 'user',
    format: 'jsonc',
    file: ({ paths, env }) => path.join(copilotHome(paths.home, env), 'settings.json'),
    writable: true,
  },
];

/**
 * List keys a repository file replaces instead of adding to, from the merge
 * column of the repository settings table. deniedUrls, disabledMcpServers
 * and disabledSkills are unions there, so they merge.
 */
const REPLACED: ReadonlySet<string> = new Set(['companyAnnouncements']);

const ALLOW_ALL = 'allow-all';

/**
 * A profile as Copilot's flags: --model, --reasoning-effort, and --mode or
 * --allow-all for the permission mode. The profile's own flags win when they
 * name the same one.
 */
export function copilotLaunchOverrides(profile: LaunchProfile): LaunchOverrides {
  const flags: Record<string, string | null> = {};
  if (profile.model !== null) {
    flags['model'] = profile.model;
  }
  if (profile.effort !== null) {
    flags['reasoning-effort'] = profile.effort;
  }
  if (profile.permissionMode === ALLOW_ALL) {
    flags[ALLOW_ALL] = null;
  } else if (profile.permissionMode !== null) {
    flags['mode'] = profile.permissionMode;
  }
  return {
    env: { ...profile.env },
    extraArgs: { ...flags, ...toExtraArgs(profile.extraArgs) },
    config: [],
  };
}

export const copilotKnobs: KnobsFacet = {
  catalog: bundledCatalog(copilotCatalog),
  layers: LAYERS,
  envPrefix: /^COPILOT_/u,
  // Copilot's settings have no env block, so env vars are only ever set in the shell.
  envBlock: null,
  neverMerges: (key) => REPLACED.has(key),
  managedReplaces: new Set(),
  launchOverrides: copilotLaunchOverrides,
};
