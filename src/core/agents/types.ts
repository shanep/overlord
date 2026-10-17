// What every agent adapter gives Overlord. An adapter fills in the facets its
// CLI supports and the UI hides the rest. Each facet below the models one is
// a first sketch that its Phase 1 workstream in META-HARNESS.md owns and may
// reshape.

import type { AgentCapabilities, AgentId, ModeOption } from '../../shared/agents.js';
import type {
  AgentNode,
  ApiRequest,
  ContextSnapshot,
  FeedItem,
  SessionSummary,
  ToolCall,
} from '../../shared/model.js';
import type { SurfaceSession } from '../../shared/protocol.js';
import type { ClaudePaths } from '../paths.js';
import type { SessionPeek } from '../transcripts/peek.js';
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

/** Where an agent's observer looks for files. */
export interface ObserverContext {
  readonly home: string;
  /** Variables that move an agent's folders, like CLAUDE_CONFIG_DIR or CODEX_HOME. */
  readonly env: ShellEnv;
  /** Claude Code's folders as the app resolved them. Only the Claude observer reads these. */
  readonly claude: ClaudePaths;
}

/** One session as a scan of the agent's folders found it. */
export interface ObservedSession {
  readonly sessionId: string;
  /** The file that holds the main thread's records. */
  readonly transcriptPath: string;
  /** Latest write to any of the session's files, compared with the active and idle windows. */
  readonly mtimeMs: number;
  /** Size of the main file in bytes. */
  readonly size: number;
}

/** A file the watcher tails for a session. */
export interface TailedFile {
  readonly path: string;
  /** The thread its records belong to. The main file uses the session id. */
  readonly agentId: string;
  /** A file that describes the thread, such as Claude's agent-<id>.meta.json, or null. */
  readonly metaPath: string | null;
}

/** What one record added, for the bus. */
export interface RecordDelta {
  readonly agentId: string;
  readonly tools: readonly ToolCall[];
  readonly requests: readonly ApiRequest[];
  readonly feed: readonly FeedItem[];
  readonly contextChanged: boolean;
  /** When the thread compacted, in ms. */
  readonly compactions: readonly number[];
}

/** Folds one session's records, from every file it has, into the shared model. */
export interface RecordAccumulator {
  /** Reads one line from a file of thread agentId. Null when the line is not a record it reads. */
  ingest: (line: string, agentId: string) => RecordDelta | null;
  summary: (now: number) => SessionSummary;
  /** The main thread first. */
  agents: (now: number) => readonly AgentNode[];
  /** True while a turn is open, so an idle session is not dropped mid-turn. */
  busy: () => boolean;
  /** What the records show about a thread's context. Left out when the agent's files do not say. */
  observedContext?: (agentId: string) => ContextSnapshot;
  /** Runs before each read of a file, for example to pick up its meta file. */
  prepare?: (file: TailedFile) => Promise<void>;
}

/** Title, folder and branch for the all-sessions list, read cheaply. */
export type PeekReader = (session: ObservedSession) => Promise<SessionPeek>;

export interface ObserverListInput {
  /** What the fleet already knows about live sessions, by id. */
  readonly known: ReadonlyMap<string, SessionSummary>;
  /** Peeks through the app's cache, so a file is read again only after it changes. */
  readonly peek: (session: ObservedSession, read: PeekReader) => Promise<SessionPeek>;
  readonly report: (message: string) => void;
}

/** The agent's files as one app sees them. TailingWatcher runs any of these. */
export interface SessionObserver<A extends RecordAccumulator = RecordAccumulator> {
  /** Names the source in errors, for example "transcripts". */
  readonly source: string;
  /** The folder fs.watch follows, or null to rely on polling alone. */
  readonly watchRoot: string | null;
  /** Every session on disk, newest first, from file metadata alone. */
  scan: () => Promise<readonly ObservedSession[]>;
  /** Files past the main one, such as subagent transcripts. Asked again on every read. */
  childFiles: (session: ObservedSession) => Promise<readonly TailedFile[]>;
  makeAccumulator: (session: ObservedSession) => A;
  /** Rows for the all-sessions list. Left out when the agent has no history to list. */
  list?: (input: ObserverListInput) => Promise<readonly SurfaceSession[]>;
}

/**
 * Sessions the agent ran without Overlord, read from its own files.
 * @public
 */
export interface ObserverFacet {
  create: (context: ObserverContext) => SessionObserver;
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
