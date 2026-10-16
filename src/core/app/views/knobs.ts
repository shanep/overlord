// The knobs view: the catalog, effective values for the open workspace, launch
// profiles, and the cached server feature flags (read only).

import type { EffectiveValue, LaunchProfile } from '../../../shared/model.js';
import type { KnobsState } from '../../../shared/protocol.js';
import { catalogEnvKeys, loadCatalog } from '../../knobs/catalog.js';
import { computeEffective } from '../../knobs/effective.js';
import { readFeatureFlags } from '../../knobs/flags.js';
import { loadLayers } from '../../knobs/layers.js';
import { listProfiles } from '../../knobs/profiles.js';
import type { ClaudePaths } from '../../paths.js';

export interface KnobsData {
  readonly effective: readonly EffectiveValue[];
  readonly featureFlags: Readonly<Record<string, unknown>>;
}

export const EMPTY_KNOBS: KnobsData = { effective: [], featureFlags: {} };

export interface KnobsLoadDeps {
  readonly paths: ClaudePaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workspace: string | null;
  readonly report: (source: string, message: string) => void;
}

const SOURCE = 'knobs';

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
  return { effective: computeEffective(layers), featureFlags: flags.flags };
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
    featureFlags: data.featureFlags,
  };
}
