// What every agent adapter gives Overlord. An adapter fills in the facets its
// CLI supports and the UI hides the rest. Each facet below the models one is
// a first sketch that its Phase 1 workstream in META-HARNESS.md owns and may
// reshape.

import type { AgentCapabilities, AgentId, ModeOption } from '../../shared/agents.js';
import type { EditTools, HookDialect } from '../hooks/normalized.js';
import type { KnobsFacet, SettingsFormat } from '../knobs/facet.js';
import type { ModelPrice } from '../transcripts/pricing.js';

import type { InstructionPolicy } from './instruction-types.js';
import type { TerminalFacet } from './launch-types.js';
import type { McpStore, LibraryFacet } from './library-types.js';
import type { ObserverFacet, TuningFacet } from './observer-types.js';
import type { ShellEnv } from './place-types.js';
import type { RuntimeFacet } from './shared/runtime.js';
import type { SyncFacet } from './sync-types.js';
import type { AgentDirs, InjectFacet, TelemetryFacet } from './talk-types.js';

export type { AgentDirs, SettingsWriteResult } from './talk-types.js';
export type { ShellEnv, AgentPlace } from './place-types.js';
export type {
  AgentCli,
  LiveSources,
  TerminalStart,
  TabLaunch,
  BackgroundStarted,
  BackgroundFacet,
  TerminalFacet,
} from './launch-types.js';
export type {
  ObservedSession,
  TailedFile,
  RateLimitReport,
  RecordDelta,
  RecordAccumulator,
  PeekReader,
  ObserverListInput,
  SessionObserver,
  PromptFile,
  PromptFileRead,
  UserPrompts,
  ObserverFacet,
  TuningSession,
  TuningFacet,
} from './observer-types.js';
export type {
  InstructionFile,
  InstructionEntry,
  InstructionBudget,
  InstructionPolicy,
} from './instruction-types.js';
export type {
  McpScope,
  McpServerConfig,
  McpServer,
  McpRead,
  McpPlace,
  McpWrite,
  McpStore,
  LibraryScope,
  LibraryFolder,
  LibraryPlace,
  TransferSkill,
  SkillsFacet,
  AgentFilesFacet,
  LibraryFacet,
} from './library-types.js';

export interface DetectInput {
  readonly env: ShellEnv;
  readonly platform: NodeJS.Platform;
  /** The binary the user set for this agent, or "" for the default name. */
  readonly path: string;
}

export interface Detected {
  /** The binary to run, or null when none was found. */
  readonly bin: string | null;
  readonly version: string | null;
}

/**
 * Context windows, prices and the default model.
 * @public
 */
export interface ModelFacet {
  /** The window for a model id, or null when the model is unknown. A prompt bigger than the standard window proves a larger one. */
  contextWindow: (model: string | null, observedTokens?: number) => number | null;
  /**
   * List price per million tokens, or null when the agent has no price for
   * the model. Null means the cost is unknown, never that it is free: an
   * agent that records its own cost, or runs on a plan with no per token
   * price, returns null here.
   */
  price: (model: string) => ModelPrice | null;
  /** What the agent runs when neither a profile nor its settings pick a model. */
  readonly defaultModel: string;
}

/**
 * The agent's own names for things that advice text mentions, so Health and
 * Tuning tell a Codex user about AGENTS.md and not CLAUDE.md.
 */
export interface AgentWords {
  /** The project instruction file, such as CLAUDE.md or AGENTS.md. */
  readonly instructionsFile: string;
  /** The command that swaps the conversation for a summary, such as /compact, or null when it has none. */
  readonly compactCommand: string | null;
  /** The command that starts over with an empty context, such as /clear or /new, or null when it has none. */
  readonly clearCommand: string | null;
  /** How to go back to an earlier turn, as advice says it, such as "/rewind (or press Esc twice)". */
  readonly rewind: string | null;
  /** The settings file the Knobs view names, such as settings.json or config.toml. Left out, it says "settings file". */
  readonly settingsFile?: string;
  /**
   * The tools that keep the task list the Fleet's progress reads, as the
   * session note names them, such as update_plan. Null when Overlord does
   * not read the agent's list, so the note does not ask for one.
   */
  readonly taskList: string | null;
  /** Connectors the session note names as examples, and a cheap call that checks one. Null for none. */
  readonly connectorExamples: { readonly examples: string; readonly probe: string } | null;
}

interface HookInstallResult {
  /** False when the file already said the same thing. */
  readonly changed: boolean;
}

/**
 * Installs the agent's hooks, reads what they send and writes the answer.
 * Workstream D owns it.
 */
export interface HooksFacet extends HookDialect {
  /** Adds the hook command to every event Overlord listens to and keeps the user's own hooks. */
  install: (dirs: AgentDirs, command: string) => Promise<HookInstallResult>;
  uninstall: (dirs: AgentDirs) => Promise<HookInstallResult>;
  /** True when any event runs Overlord's hook command. */
  installed: (dirs: AgentDirs) => Promise<boolean>;
  /**
   * Tools that write files, each with the input fields that can hold the
   * path, tried in order. The coordinator watches these for edits.
   */
  readonly editTools: EditTools;
}

/**
 * Settings layers, knobs, MCP servers and skills. Workstreams E2 to E5 own it.
 * @public
 */
export interface ConfigFacet {
  /** The format of the agent's main settings file. */
  readonly settingsFormat: SettingsFormat;
  /** Knob catalog, settings layers and precedence, and launch overrides. Workstream E2 owns it. */
  readonly knobs?: KnobsFacet;
  /** The agent's MCP servers. Workstream E3 owns it. */
  readonly mcp?: McpStore;
  /** The agent's skill folders and custom agent files. Workstream E4 owns it. */
  readonly library?: LibraryFacet;
  /** What config sync keeps for the agent. Claude Code leaves it out and syncs the way it always has. */
  readonly sync?: SyncFacet;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly name: string;
  readonly short: string;
  /** A codicon id. */
  readonly icon: string;
  detect: (input: DetectInput) => Promise<Detected>;
  readonly capabilities: AgentCapabilities;
  readonly modes: {
    readonly permission: readonly ModeOption[];
    readonly effort: readonly ModeOption[];
  };
  readonly models: ModelFacet;
  /** Names advice text uses. Left out, Health and Tuning use plain words and skip the advice that needs a command. */
  readonly words?: AgentWords;
  readonly runtime?: RuntimeFacet;
  readonly terminal?: TerminalFacet;
  readonly observer?: ObserverFacet;
  readonly hooks?: HooksFacet;
  readonly telemetry?: TelemetryFacet;
  readonly inject?: InjectFacet;
  readonly instructions?: InstructionPolicy;
  readonly config?: ConfigFacet;
  readonly tuning?: TuningFacet;
}
