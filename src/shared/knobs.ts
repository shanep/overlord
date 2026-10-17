// The Knobs view's state: one agent's catalog, effective values and
// settings files, with what the view needs to name that agent and save to it.

import type { AgentId } from './agents.js';
import type {
  EffectiveValue,
  KnobDefinition,
  LaunchProfile,
  SettingsFileSummary,
} from './model.js';

/** A settings layer the Knobs view can save to. */
export type EditableLayer = 'user' | 'project' | 'project-local';

export interface KnobsState {
  /** The agent whose knobs these are. Unset is Claude Code. */
  readonly agent?: AgentId;
  /** Every enabled agent with knobs, for the pick in the header. */
  readonly knobAgents: readonly AgentId[];
  /** The layers a knob can be saved to, in the order the layer pick lists them. */
  readonly writableLayers: readonly EditableLayer[];
  /** True when the agent's settings can set env vars, as Claude Code's env block does. */
  readonly envInSettings: boolean;
  /** What the view calls the agent's settings file, from its words, such as config.toml. */
  readonly settingsFile: string;
  /** The agent's instruction file, such as AGENTS.md, which names the memory area. */
  readonly instructionsFile: string;
  readonly catalog: readonly KnobDefinition[];
  readonly effective: readonly EffectiveValue[];
  readonly profiles: readonly LaunchProfile[];
  /** The settings files behind the layers, highest precedence first. */
  readonly files: readonly SettingsFileSummary[];
  /** Cached server feature flags, read-only. */
  readonly featureFlags: Readonly<Record<string, unknown>>;
}
