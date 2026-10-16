// The knobs view: the catalog, effective values for the open workspace, the
// settings files behind them, launch profiles, and the cached server feature
// flags (read only).

import { access } from 'node:fs/promises';

import type { EffectiveValue, LaunchProfile, SettingsFileSummary } from '../../../shared/model.js';
import type { KnobsState } from '../../../shared/protocol.js';
import { catalogEnvKeys, loadCatalog } from '../../knobs/catalog.js';
import { computeEffective, flattenSettings } from '../../knobs/effective.js';
import { readFeatureFlags } from '../../knobs/flags.js';
import { loadLayers, type LayerData } from '../../knobs/layers.js';
import { listProfiles } from '../../knobs/profiles.js';
import type { ClaudePaths } from '../../paths.js';

export interface KnobsData {
  readonly effective: readonly EffectiveValue[];
  readonly files: readonly SettingsFileSummary[];
  readonly featureFlags: Readonly<Record<string, unknown>>;
}

export const EMPTY_KNOBS: KnobsData = { effective: [], files: [], featureFlags: {} };

export interface KnobsLoadDeps {
  readonly paths: ClaudePaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workspace: string | null;
  readonly report: (source: string, message: string) => void;
}

const SOURCE = 'knobs';

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** The layers that come from a settings file, with what each one holds. */
async function summarizeFiles(layers: readonly LayerData[]): Promise<SettingsFileSummary[]> {
  const withFiles = layers.flatMap((layer) =>
    layer.file === null || layer.layer === 'cli' ? [] : [{ ...layer, file: layer.file }],
  );
  return Promise.all(
    withFiles.map(async (layer) => ({
      layer: layer.layer,
      file: layer.file,
      exists: await exists(layer.file),
      keys: flattenSettings(layer.values).size,
      error: layer.error,
    })),
  );
}

export async function loadKnobs(deps: KnobsLoadDeps): Promise<KnobsData> {
  const layers = await loadLayers({
    paths: deps.paths,
    projectDir: deps.workspace,
    env: deps.env,
    envKeys: catalogEnvKeys(loadCatalog()),
  });
  for (const layer of layers) {
    if (layer.error !== null) {
      deps.report(SOURCE, layer.error);
    }
  }
  const flags = await readFeatureFlags(deps.paths);
  if (flags.error !== null) {
    deps.report(SOURCE, flags.error);
  }
  return {
    effective: computeEffective(layers),
    files: await summarizeFiles(layers),
    featureFlags: flags.flags,
  };
}

export async function loadProfiles(
  file: string,
  report: (source: string, message: string) => void,
): Promise<readonly LaunchProfile[]> {
  const list = await listProfiles(file);
  if (list.error !== null) {
    report('profiles', list.error);
  }
  return list.profiles;
}

export function buildKnobs(data: KnobsData, profiles: readonly LaunchProfile[]): KnobsState {
  return {
    catalog: loadCatalog(),
    effective: data.effective,
    profiles,
    files: data.files,
    featureFlags: data.featureFlags,
  };
}
