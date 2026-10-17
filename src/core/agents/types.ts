// What every agent adapter gives Overlord. An adapter fills in the facets its
// CLI supports and the UI hides the rest. Each facet below the models one is
// a first sketch that its Phase 1 workstream in META-HARNESS.md owns and may
// reshape.

import type { AgentCapabilities, AgentId, ModeOption } from '../../shared/agents.js';
import type { ModelPrice } from '../transcripts/pricing.js';

/** The environment to look for binaries in, usually the login shell's. */
export type ShellEnv = Readonly<Record<string, string | undefined>>;

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
  /** List price per million tokens, or null when the model has none. */
  price: (model: string) => ModelPrice | null;
  /** What the agent runs when neither a profile nor its settings pick a model. */
  readonly defaultModel: string;
}

/**
 * Runs the agent from code for the Launcher. Workstream A replaces the
 * options and the run with neutral StartOptions, AgentRun and AgentEvent.
 * @public
 */
export interface RuntimeFacet {
  start: (options: unknown) => AsyncIterable<unknown>;
}

/**
 * Terminal tabs, background runs and stop. Workstream B owns it.
 * @public
 */
export interface TerminalFacet {
  newArgs: () => readonly string[];
  resumeArgs: (sessionId: string, fork: boolean) => readonly string[];
  tabName: (title: string) => string;
}

/**
 * Sessions the agent ran without Overlord, read from its own files.
 * Workstream C owns it.
 * @public
 */
export interface ObserverFacet {
  scan: () => Promise<readonly { readonly sessionId: string; readonly transcriptPath: string }[]>;
}

/**
 * Installs the agent's hooks and reads what they send. Workstream D owns it.
 * @public
 */
export interface HooksFacet {
  install: (command: string) => Promise<void>;
  uninstall: () => Promise<void>;
  /** The tool names and input fields the coordinator watches for file edits. */
  readonly editTools: Readonly<Record<string, string>>;
}

/**
 * Turns on the agent's OTLP export. Workstream D owns it.
 * @public
 */
export interface TelemetryFacet {
  enable: (port: number) => Promise<void>;
}

/**
 * How Overlord's notes, the launch check and the connector briefing reach a
 * session. Workstream D owns it.
 * @public
 */
export interface InjectFacet {
  readonly via: 'hook' | 'launch-argument' | 'first-prompt';
}

/**
 * Which instruction files the agent reads. Workstream E1 owns it.
 * @public
 */
export interface InstructionPolicy {
  /** File names looked for in each folder, for example CLAUDE.md or AGENTS.md. */
  readonly fileNames: readonly string[];
}

/**
 * Settings layers, knobs, MCP servers and skills. Workstreams E2 to E5 own it.
 * @public
 */
export interface ConfigFacet {
  readonly settingsFormat: 'json' | 'jsonc' | 'toml';
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
  readonly runtime?: RuntimeFacet;
  readonly terminal?: TerminalFacet;
  readonly observer?: ObserverFacet;
  readonly hooks?: HooksFacet;
  readonly telemetry?: TelemetryFacet;
  readonly inject?: InjectFacet;
  readonly instructions?: InstructionPolicy;
  readonly config?: ConfigFacet;
}
