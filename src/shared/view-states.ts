// The state each webview other than Usage gets from the host.

import type { AgentId, RateLimitWindow } from './agents.js';
import type { FleetHealth, SessionHealth } from './health.js';
import type {
  AgentNode,
  ApiRequest,
  ConfigItem,
  ContextSnapshot,
  FeedItem,
  LaunchProfile,
  LaunchSpec,
  PermissionRequest,
  SessionPlace,
  SessionSummary,
  ToolCall,
} from './model.js';
import type { Plan } from './plans.js';
import type { FleetProgress } from './progress.js';
import type { AutoApproveRule } from './rules.js';
import type { WorktreeSummary } from './worktrees.js';

/** The first three fields are Claude Code's 5 hour and 7 day windows and when the 5 hour one resets. */
export interface RateLimits {
  readonly fiveHourPct: number | null;
  readonly sevenDayPct: number | null;
  readonly resetsAt: number | null;
  /** Every window any agent reported, Claude Code's included. Left out until the first one arrives. */
  readonly windows?: readonly RateLimitWindow[];
}

export interface ProjectSummary {
  /** "git:" plus the repository root for a git project, a random id for one made by hand. */
  readonly id: string;
  readonly name: string;
  readonly kind: 'git' | 'manual';
  /** The repository root of a git project, or the folder set for one made by hand, else null. */
  readonly folder: string | null;
}

/** The project a session belongs to, once Overlord has looked at its folder. */
export interface SessionProject {
  /** Null while the session is in no project. */
  readonly projectId: string | null;
  /** The folder a move applies to: the repository root, or else the session's folder. */
  readonly folder: string;
  /** The user said never to ask about this folder. */
  readonly ignored: boolean;
}

export interface FleetState {
  readonly sessions: readonly SessionSummary[];
  readonly agents: readonly AgentNode[];
  readonly pendingPermissions: readonly PermissionRequest[];
  /**
   * The session to highlight: the one in the focused terminal, or else the
   * one that belongs to this window's folder.
   */
  readonly activeSessionId: string | null;
  /** Changes each time the fleet should highlight it again. */
  readonly activeVersion: number;
  /** Where each session with a live process runs, by session id. */
  readonly places: Readonly<Record<string, SessionPlace>>;
  /** Every project made by hand and every git project a session is in. */
  readonly projects: readonly ProjectSummary[];
  /** Each session's project by session id. Sessions whose folder is still being checked are left out. */
  readonly sessionProjects: Readonly<Record<string, SessionProject>>;
  /** The projects of this window's workspace folders, which the fleet lists even with no sessions. */
  readonly workspaceProjects: readonly string[];
  readonly rateLimits: RateLimits;
  /** Spend per hour over the last hour, all sessions. */
  readonly spendPerHourUsd: number;
  /** Health of each unfinished session that has done any work, by session id. */
  readonly health: Readonly<Record<string, FleetHealth>>;
  /** The sessions the Launcher started, which stay in the fleet until removed by hand. */
  readonly launched: readonly string[];
  /** Task list progress, subagent spend and token budget of each session that has any, by session id. */
  readonly progress: Readonly<Record<string, FleetProgress>>;
}

export interface AgentDetailState {
  readonly agent: AgentNode | null;
  readonly session: SessionSummary | null;
  readonly children: readonly AgentNode[];
  /** Subagents below this agent, at any depth, that ended with an error. */
  readonly failedAgents: readonly AgentNode[];
  /** What the parent got back from this agent's Agent call, when this agent failed. */
  readonly failure: string | null;
  readonly feed: readonly FeedItem[];
  readonly toolCalls: readonly ToolCall[];
  readonly requests: readonly ApiRequest[];
  /** Compaction times, for chart markers. */
  readonly compactions: readonly number[];
}

/** The session running in a Claude CLI tab, for the properties panel beside it. */
export interface PropertiesState {
  /** The session the tab runs, or null when no CLI tab is active. */
  readonly sessionId: string | null;
  /** Null until Claude Code reports the session, which can lag the tab opening. */
  readonly session: SessionSummary | null;
  /** Subagents in this session, all depths, oldest first. */
  readonly agents: readonly AgentNode[];
  readonly pendingPermissions: readonly PermissionRequest[];
  /** Signs the session is working worse than it did, null until it is reported. */
  readonly health: SessionHealth | null;
}

export interface ContextState {
  /** The agent of the snapshot's session. Unset is Claude Code. */
  readonly agent?: AgentId;
  readonly snapshot: ContextSnapshot | null;
  readonly sessions: readonly { readonly id: string; readonly title: string }[];
}

export interface LaunchRun {
  readonly id: string;
  readonly batchId: string;
  readonly spec: LaunchSpec;
  readonly sessionId: string | null;
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  /** What the run cost so far, or null until it reports dollars. Agents like Codex never do. */
  readonly costUsd: number | null;
  readonly turns: number;
  readonly durationMs: number;
  readonly result: string | null;
  readonly worktreePath: string | null;
}

/** A folder the Launcher form offers to run in. */
export interface LaunchFolder {
  readonly name: string;
  readonly folder: string;
  /** This window's folder (home in a window with none), a project in the fleet, or one picked with Browse. */
  readonly source: 'window' | 'home' | 'project' | 'browsed';
}

export interface LauncherState {
  readonly runs: readonly LaunchRun[];
  readonly profiles: readonly LaunchProfile[];
  readonly drafts: readonly {
    readonly id: string;
    readonly label: string;
    readonly prompt: string;
  }[];
  readonly pendingPermissions: readonly PermissionRequest[];
  readonly rules: readonly AutoApproveRule[];
  readonly maxConcurrency: number;
  /** Why queued runs are waiting, such as a nearly used usage limit, or null. */
  readonly held: string | null;
  /** Goals split into tasks for separate sessions, newest first. */
  readonly plans: readonly Plan[];
  readonly worktrees: readonly WorktreeSummary[];
  /** Where a run works when the form leaves Folder empty. */
  readonly defaultFolder: string;
  /** The folders the form offers, the default one first. */
  readonly folders: readonly LaunchFolder[];
  /** The last folder picked with Browse and when, so the form can select it, or null. */
  readonly browsed: { readonly folder: string; readonly at: number } | null;
}

export interface SurfaceSession {
  readonly id: string;
  readonly agent: AgentId;
  readonly surface: SessionSummary['surface'];
  readonly title: string;
  readonly cwd: string | null;
  readonly updatedAt: number;
  readonly archived: boolean;
  /** Handoffs this session supports right now. */
  readonly handoffs: readonly HandoffKind[];
}

export type HandoffKind = 'resume-local' | 'open-desktop' | 'teleport-local' | 'remote-control';

export interface SessionsState {
  readonly sessions: readonly SurfaceSession[];
  readonly claudeAiImportedAt: number | null;
  /** Session folder to the repository it belongs to, for folders that are worktrees. */
  readonly projects: Readonly<Record<string, string>>;
  /** Ids of the sessions running now, in a terminal, in the background or in the launcher. */
  readonly active: readonly string[];
}

/** Where the background config sync is. */
export interface ConfigSyncStatus {
  /** Off means overlord.configSync.auto is false. */
  readonly state: 'off' | 'idle' | 'syncing' | 'error';
  /** When the last sync finished cleanly, in epoch ms. */
  readonly lastSyncAt: number | null;
  /** What went wrong, when the state is error. */
  readonly message: string | null;
}

export interface ConfigState {
  readonly items: readonly ConfigItem[];
  readonly repo: {
    readonly connected: boolean;
    readonly remote: string | null;
    readonly path: string | null;
    readonly ahead: number;
    readonly behind: number;
    readonly dirty: number;
  };
  readonly sync: ConfigSyncStatus;
}

/** One message between agents or sessions, from the transcripts. */
export interface AgentMessage {
  readonly id: string;
  readonly at: number;
  readonly sessionId: string;
  /** The title of the session whose transcript holds it. */
  readonly sessionTitle: string;
  /** The address: an agent id, "main", another session's name or uds: address, or "*". */
  readonly from: string;
  readonly to: string;
  /** What to call each side: an agent's description, "Main conversation" or a session title. */
  readonly fromName: string;
  readonly toName: string;
  readonly kind: 'send' | 'receive' | 'broadcast' | 'task-notification' | 'hand-back';
  readonly preview: string;
  /** True when a rule or hook stopped it. */
  readonly blocked: boolean;
}

/** Messages from one session to another, both sides named by session title. */
export interface MessageRoute {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly lastAt: number;
}

export interface MessagesState {
  readonly messages: readonly AgentMessage[];
  readonly routes: readonly MessageRoute[];
  /** The crossSessionInbound setting in effect, or null when unset. */
  readonly inboundPolicy: string | null;
  readonly inboundChoices: readonly string[];
  /** Auto-approve rules whose tool pattern covers SendMessage. */
  readonly rules: readonly AutoApproveRule[];
}
