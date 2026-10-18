// How Overlord reads an agent's sessions: the files it watches, the records
// it folds into the model, the prompts Reputation reads and the Tuning scan.

import type { RateLimitWindow } from '../../shared/agents.js';
import type {
  AgentNode,
  ApiRequest,
  ContextSnapshot,
  FeedItem,
  SessionSummary,
  ToolCall,
} from '../../shared/model.js';
import type { SurfaceSession } from '../../shared/protocol.js';
import type { Prompt } from '../reputation/prompts.js';
import type { SessionPeek } from '../transcripts/peek.js';
import type { SessionMeasure } from '../tuning/measure.js';

import type { AgentPlace } from './place-types.js';

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

/** Rate limit windows a record reported, and when, so an older file never undoes a newer one. */
export interface RateLimitReport {
  readonly at: number;
  readonly windows: readonly RateLimitWindow[];
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
  /** Plan limits the record reported, for an agent that writes them to its files, like Codex. */
  readonly rateLimits?: RateLimitReport;
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
  /**
   * True when the agent writes its plan limits to its session files, like
   * Codex and Copilot, so the newest sessions are read for them at startup
   * even when none is active.
   */
  readonly reportsLimits?: boolean;
  /** Every session on disk, newest first, from file metadata alone. */
  scan: () => Promise<readonly ObservedSession[]>;
  /** Files past the main one, such as subagent transcripts. Asked again on every read. */
  childFiles: (session: ObservedSession) => Promise<readonly TailedFile[]>;
  makeAccumulator: (session: ObservedSession) => A;
  /** Rows for the all-sessions list. Left out when the agent has no history to list. */
  list?: (input: ObserverListInput) => Promise<readonly SurfaceSession[]>;
}

/** A file that holds prompts the user typed, for Reputation. */
export interface PromptFile {
  readonly path: string;
  /** Null for a file that is not there right now, such as a history file not written yet. */
  readonly stamp: { readonly mtimeMs: number; readonly size: number } | null;
  /**
   * A session's own file, which names the session, or a history file that
   * keeps prompts from many sessions after their transcripts are gone.
   */
  readonly kind: 'transcript' | 'history';
  /** The session a transcript belongs to. Null for a history file. */
  readonly sessionId: string | null;
}

/** What one prompt file holds. */
export interface PromptFileRead {
  readonly prompts: readonly Prompt[];
  /** The session's title, for a transcript that has one. */
  readonly title: string | null;
}

/** Where the agent keeps what the user typed. Reputation reads these. */
export interface UserPrompts {
  /** Every prompt file. A history file that is missing is still listed, with a null stamp, so its old stamp is kept. */
  files: () => Promise<readonly PromptFile[]>;
  /** Reads one file. Called only when its stamp changed since the last scan. */
  read: (file: PromptFile) => Promise<PromptFileRead>;
}

/**
 * Sessions the agent ran without Overlord, read from its own files.
 * @public
 */
export interface ObserverFacet {
  create: (context: AgentPlace) => SessionObserver;
  /** The prompts the user typed, for Reputation. Left out when the agent's files do not keep them. */
  userPrompts?: (context: AgentPlace) => UserPrompts;
}

/** One session's files as the Tuning scan sees them. */
export interface TuningSession {
  readonly sessionId: string;
  /** The main file, which keys the session in the Tuning index. */
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * Reads the agent's past sessions for the Tuning view. Each agent parses its
 * own denial text, model ids and cache fields, and the rules and totals are
 * shared.
 */
export interface TuningFacet {
  /** Every session on disk, from file metadata alone. */
  sessions: (context: AgentPlace) => Promise<readonly TuningSession[]>;
  /** Reads one session's files and measures them. */
  measure: (session: TuningSession) => Promise<SessionMeasure>;
  /** The knobs a tip's advice sets, by tip id, for an agent whose knobs differ from Claude Code's. */
  readonly knobs?: Readonly<Record<string, readonly string[]>>;
}
