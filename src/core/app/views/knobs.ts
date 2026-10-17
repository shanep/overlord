// The knobs view: one agent's catalog, effective values for the open
// workspace, the settings files behind them, launch profiles, and Claude
// Code's cached server feature flags (read only). Every agent with a knobs
// facet is loaded, and the view shows the one picked in its header.

import { access } from 'node:fs/promises';

import type { AgentId } from '../../../shared/agents.js';
import { CLAUDE_CODE } from '../../../shared/agents.js';
import type { EffectiveValue, LaunchProfile, SettingsFileSummary } from '../../../shared/model.js';
import type { EditableLayer, KnobsState } from '../../../shared/protocol.js';
import { claudeKnobs } from '../../agents/claude/config.js';
import type { AgentRegistry } from '../../agents/registry.js';
import { catalogEnvKeys } from '../../knobs/catalog.js';
import { computeEffective, flattenSettings } from '../../knobs/effective.js';
import type { KnobsFacet } from '../../knobs/facet.js';
import { readFeatureFlags } from '../../knobs/flags.js';
import { loadLayers, type LayerData } from '../../knobs/layers.js';
import { listProfiles } from '../../knobs/profiles.js';
import type { ClaudePaths } from '../../paths.js';

/** One agent's knobs as read from its settings files. */
export interface KnobsData {
  readonly effective: readonly EffectiveValue[];
  readonly files: readonly SettingsFileSummary[];
  readonly featureFlags: Readonly<Record<string, unknown>>;
}

/** Every agent's knobs, by agent id. */
export type KnobsByAgent = Readonly<Record<AgentId, KnobsData>>;

export const EMPTY_KNOBS: KnobsData = { effective: [], files: [], featureFlags: {} };

/** One agent's knobs, or none when it was not loaded. Unset is Claude Code. */
export function knobsOf(all: KnobsByAgent, agent: AgentId = CLAUDE_CODE): KnobsData {
  return Object.hasOwn(all, agent) ? (all[agent] ?? EMPTY_KNOBS) : EMPTY_KNOBS;
}

/** The knobs facet of an agent, or null when it has none. Unset is Claude Code. */
export function knobsFacet(
  registry: AgentRegistry,
  agent: AgentId = CLAUDE_CODE,
): KnobsFacet | null {
  return registry.get(agent)?.config?.knobs ?? null;
}

export interface KnobsLoadDeps {
  readonly paths: ClaudePaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workspace: string | null;
  readonly report: (source: string, message: string) => void;
}

/** What one agent's knobs load needs past the shared deps. */
interface AgentKnobs {
  readonly agent: AgentId;
  readonly knobs: KnobsFacet;
}

const SOURCE = 'knobs';

const CLAUDE_KNOBS: AgentKnobs = { agent: CLAUDE_CODE, knobs: claudeKnobs };

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

/** One agent's knobs. Claude Code's when no agent is given, and only Claude Code has feature flags. */
export async function loadKnobs(
  deps: KnobsLoadDeps,
  { agent, knobs }: AgentKnobs = CLAUDE_KNOBS,
): Promise<KnobsData> {
  const layers = await loadLayers({
    knobs,
    paths: deps.paths,
    projectDir: deps.workspace,
    env: deps.env,
    envKeys: catalogEnvKeys(knobs.catalog()),
  });
  for (const layer of layers) {
    if (layer.error !== null) {
      deps.report(SOURCE, layer.error);
    }
  }
  let featureFlags: Readonly<Record<string, unknown>> = {};
  if (agent === CLAUDE_CODE) {
    const flags = await readFeatureFlags(deps.paths);
    if (flags.error !== null) {
      deps.report(SOURCE, flags.error);
    }
    featureFlags = flags.flags;
  }
  return {
    effective: computeEffective(layers, knobs),
    files: await summarizeFiles(layers),
    featureFlags,
  };
}

/** The knobs of every agent with a knobs facet, enabled or not, since a launch reads Claude Code's. */
export async function loadAllKnobs(
  registry: AgentRegistry,
  deps: KnobsLoadDeps,
): Promise<KnobsByAgent> {
  const loaded = await Promise.all(
    registry.list().flatMap((adapter) => {
      const knobs = adapter.config?.knobs;
      return knobs === undefined
        ? []
        : [
            loadKnobs(deps, { agent: adapter.id, knobs }).then(
              (data) => [adapter.id, data] as const,
            ),
          ];
    }),
  );
  return Object.fromEntries(loaded);
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

/** The enabled agents the Knobs view can show, in registry order. */
export function knobAgents(
  registry: AgentRegistry,
  enabled: (id: AgentId) => boolean,
): readonly AgentId[] {
  return registry
    .list()
    .filter((adapter) => adapter.config?.knobs !== undefined && enabled(adapter.id))
    .map((adapter) => adapter.id);
}

/** The picked agent when it can be shown, else Claude Code, else the first one there is. */
export function shownKnobsAgent(listed: readonly AgentId[], picked: AgentId): AgentId {
  if (listed.includes(picked)) {
    return picked;
  }
  return listed.includes(CLAUDE_CODE) ? CLAUDE_CODE : (listed[0] ?? CLAUDE_CODE);
}

/** The order the layer pick lists them in, which is the order it always had. */
const LAYER_ORDER: readonly EditableLayer[] = ['user', 'project', 'project-local'];

/** The layers the Knobs view may save an agent's knobs to. */
export function writableLayers(knobs: KnobsFacet): readonly EditableLayer[] {
  const writable = new Set(
    knobs.layers.flatMap((source) =>
      source.kind === 'file' && source.writable ? [source.layer] : [],
    ),
  );
  return LAYER_ORDER.filter((layer) => writable.has(layer));
}

export interface KnobsViewInput {
  readonly data: KnobsByAgent;
  readonly profiles: readonly LaunchProfile[];
  readonly registry: AgentRegistry;
  readonly enabled: (id: AgentId) => boolean;
  /** The agent picked in the view's header. */
  readonly picked: AgentId;
}

export function buildKnobs(input: KnobsViewInput): KnobsState {
  const listed = knobAgents(input.registry, input.enabled);
  const agent = shownKnobsAgent(listed, input.picked);
  const adapter = input.registry.get(agent);
  const knobs = adapter?.config?.knobs ?? claudeKnobs;
  const data = knobsOf(input.data, agent);
  return {
    agent,
    knobAgents: listed,
    writableLayers: writableLayers(knobs),
    envInSettings: knobs.envBlock !== null,
    settingsFile: adapter?.words?.settingsFile ?? 'settings file',
    instructionsFile: adapter?.words?.instructionsFile ?? 'instruction file',
    catalog: knobs.catalog(),
    effective: data.effective,
    profiles: input.profiles,
    files: data.files,
    featureFlags: data.featureFlags,
  };
}
