// The knobs part of an agent's config facet: its knob catalog, the settings
// layers it reads with each file's format and precedence, how list values
// merge across layers, and how a launch profile becomes launch overrides.
// The knobs code reads all of this from the facet, so it holds no agent's
// file names or rules itself.

import type { KnobDefinition, LaunchProfile, SettingsLayer } from '../../shared/model.js';
import type { ClaudePaths } from '../paths.js';

import type { TomlEditValue } from './toml-scan.js';

/** How a settings file is read and written. TOML goes through the line-level editor in toml-edit.ts. */
export type SettingsFormat = 'json' | 'toml';

/** What a layer needs to find its file. */
export interface SettingsPlace {
  /** The home folder and Claude's resolved folders, which tests point at temp dirs. */
  readonly paths: Pick<ClaudePaths, 'home' | 'managedDir' | 'userSettings'>;
  /** The workspace folder, or null outside a project. */
  readonly projectDir: string | null;
  /** For agents whose home moves with a variable, like CODEX_HOME. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type LayerSource =
  | {
      readonly kind: 'file';
      readonly layer: SettingsLayer;
      readonly format: SettingsFormat;
      /** The file, or null when the layer needs a project and none is open. */
      readonly file: (place: SettingsPlace) => string | null;
      /** True when the Knobs view may save knobs here. */
      readonly writable: boolean;
    }
  /** Settings passed for one launch, like Claude's --settings. */
  | { readonly kind: 'cli'; readonly layer: SettingsLayer }
  /** Variables from the process env, shaped as an env block. */
  | { readonly kind: 'env'; readonly layer: SettingsLayer };

/**
 * One setting for a single launch, which Codex takes as `-c key=value`. A
 * value the TOML editor cannot write, such as an inline table, or one the
 * user typed in a profile, goes in as raw TOML text.
 */
export type ConfigOverride =
  | { readonly key: readonly string[]; readonly value: TomlEditValue }
  | { readonly key: readonly string[]; readonly raw: string };

/** What a launch needs from a profile. Unset fields are left out. */
export interface LaunchOverrides {
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly env: Readonly<Record<string, string>>;
  /** Flag name without dashes to value, null for a bare flag, as the Agent SDK's extraArgs. */
  readonly extraArgs: Readonly<Record<string, string | null>>;
  /** Settings for this launch only. Claude has none, Codex passes each with -c. */
  readonly config: readonly ConfigOverride[];
}

export interface KnobsFacet {
  /** Every documented setting, env var and flag. */
  readonly catalog: () => readonly KnobDefinition[];
  /** Every layer the agent reads, highest precedence first. */
  readonly layers: readonly LayerSource[];
  /** Env vars the env layer shows even when the catalog does not list them. */
  readonly envPrefix: RegExp | null;
  /** The settings block env vars are set under (Claude's `env`), or null when settings cannot set them. */
  readonly envBlock: string | null;
  /** List keys the highest layer sets alone, instead of merging every layer's entries. */
  readonly neverMerges: (key: string) => boolean;
  /** List keys a managed layer sets as is, with no entries added from lower layers. */
  readonly managedReplaces: ReadonlySet<string>;
  /** How a profile's settings reach a launch of this agent. */
  readonly launchOverrides: (profile: LaunchProfile) => LaunchOverrides;
}
