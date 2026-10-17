// Typed messages between the extension host and the webviews. Every message
// is plain JSON. The host sends a full `state` for the active view and then
// `patch` messages as data changes. The webview sends `ready` once and then
// `action` messages for user intent.

import type { ActivityState } from './activity.js';
import type { AgentId, AgentInfo, RateLimitWindow } from './agents.js';
import type { BridgeUsage } from './bridge-usage.js';
import type { CatalogKind, LibraryState } from './catalog.js';
import type { ConnectorsState } from './connectors.js';
import type { FleetHealth, SessionHealth } from './health.js';
import type { EditableLayer, KnobsState } from './knobs.js';
import type {
  AgentNode,
  ApiRequest,
  ConfigItem,
  ContextSnapshot,
  DailyUsage,
  FeedItem,
  KnobKind,
  LaunchProfile,
  LaunchSpec,
  PermissionDecision,
  PermissionRequest,
  SessionPlace,
  SessionSummary,
  ToolCall,
} from './model.js';
import type { Plan } from './plans.js';
import type { FleetProgress } from './progress.js';
import type { ReputationState } from './reputation.js';
import type { AutoApproveRule } from './rules.js';
import type { TuningState } from './tuning.js';
import type { WorktreeSummary } from './worktrees.js';

export type { EditableLayer, KnobsState } from './knobs.js';
export type { WorktreeOverlap, WorktreeState, WorktreeSummary } from './worktrees.js';

export const VIEW_IDS = [
  'fleet',
  'agent',
  'context',
  'knobs',
  'launcher',
  'sessions',
  'config',
  'usage',
  'reputation',
  'messages',
  'properties',
  'help',
  'tuning',
  'connectors',
  'activity',
  'skills',
  'agents',
] as const;

export type ViewId = (typeof VIEW_IDS)[number];

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

export interface UsageStats {
  readonly days: readonly DailyUsage[];
  readonly hourCounts: Readonly<Record<string, number>>;
  readonly totalSessions: number;
  readonly totalMessages: number;
  readonly climate: ClimateEstimate;
  /** Calls through the boisestate.ai bridge. Absent until the sidecar has logged one. */
  readonly bridge?: BridgeUsage;
}

/** The numbers behind the climate estimate, so the view can show its working. */
export interface ClimateAssumptions {
  readonly whPerListDollar: number;
  readonly kgCo2ePerKwh: number;
  readonly litersPerKwh: number;
  readonly kgCo2ePerMile: number;
  readonly kwhPerHomeDay: number;
}

/** One model's share of the climate estimate. */
export interface ModelClimate {
  readonly model: string;
  readonly tokens: number;
  readonly energyKwh: number;
  readonly co2eKg: number;
}

/** A rough estimate of the energy, carbon and water behind the usage history. */
export interface ClimateEstimate {
  readonly energyKwh: number;
  readonly co2eKg: number;
  readonly waterLiters: number;
  /** Miles in an average gas car with the same CO2e. */
  readonly drivingMiles: number;
  /** Days of an average US home's electricity. */
  readonly homeDays: number;
  /** Tokens from models with no list price, left out of the totals. */
  readonly unpricedTokens: number;
  /** Largest energy first. */
  readonly models: readonly ModelClimate[];
  readonly assumptions: ClimateAssumptions;
}

/** One plan limit window, such as the current session or the current week. */
export interface PlanLimit {
  /** The server's meter kind, for example "session", "weekly_all" or "weekly_scoped". */
  readonly kind: string;
  readonly label: string;
  /** Share of the window used, 0 to 100. */
  readonly percent: number;
  /** Epoch ms when the window resets, or null when unknown. */
  readonly resetsAt: number | null;
  /** The server's grading of the meter: "normal", "warning" or "critical". */
  readonly severity: string;
}

/** The claude.ai plan limits that /usage shows. */
export interface PlanLimits {
  /** "pro", "max", "team" or "enterprise", or null when unknown. */
  readonly subscription: string | null;
  readonly limits: readonly PlanLimit[];
  /** Epoch ms of the read. */
  readonly fetchedAt: number;
}

export interface UsageState extends UsageStats {
  /** Null when plan limits do not apply (API key, Bedrock, Vertex) or could not be read. */
  readonly plan: PlanLimits | null;
  /** Usage limit windows the agents' sessions reported. Left out before the first one. */
  readonly windows?: readonly RateLimitWindow[];
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

/** The help page is static, so it needs no data from the host. */
type HelpState = Readonly<Record<string, never>>;

interface ViewStateMap {
  readonly fleet: FleetState;
  readonly agent: AgentDetailState;
  readonly context: ContextState;
  readonly knobs: KnobsState;
  readonly launcher: LauncherState;
  readonly sessions: SessionsState;
  readonly config: ConfigState;
  readonly usage: UsageState;
  readonly reputation: ReputationState;
  readonly messages: MessagesState;
  readonly properties: PropertiesState;
  readonly help: HelpState;
  readonly tuning: TuningState;
  readonly connectors: ConnectorsState;
  readonly activity: ActivityState;
  readonly skills: LibraryState;
  readonly agents: LibraryState;
}

/** One view's state, before the host adds what every view gets. */
export type ViewStateMessage = {
  readonly [V in ViewId]: {
    readonly type: 'state';
    readonly view: V;
    readonly state: ViewStateMap[V];
  };
}[ViewId];

export type HostToWebview = ViewStateMessage & {
  /** Every agent Overlord knows, installed or not. */
  readonly agents: readonly AgentInfo[];
};

export type WebviewAction =
  | { readonly type: 'openSession'; readonly sessionId: string }
  | { readonly type: 'openAgent'; readonly sessionId: string; readonly agentId: string }
  | { readonly type: 'openContext'; readonly sessionId: string; readonly agentId: string | null }
  | { readonly type: 'openProperties'; readonly sessionId: string }
  | { readonly type: 'interrupt'; readonly sessionId: string }
  | { readonly type: 'stop'; readonly sessionId: string }
  | { readonly type: 'removeSession'; readonly sessionId: string }
  | { readonly type: 'setModel'; readonly sessionId: string; readonly model: string }
  | { readonly type: 'setPermissionMode'; readonly sessionId: string; readonly mode: string }
  | {
      readonly type: 'resolvePermission';
      readonly requestId: string;
      readonly decision: PermissionDecision;
    }
  | { readonly type: 'launch'; readonly specs: readonly LaunchSpec[] }
  | { readonly type: 'stopRun'; readonly runId: string }
  | { readonly type: 'stopAll' }
  | { readonly type: 'browseLaunchFolder' }
  | { readonly type: 'alwaysAllowPermission'; readonly requestId: string }
  | { readonly type: 'saveRule'; readonly rule: AutoApproveRule }
  | { readonly type: 'deleteRule'; readonly ruleId: string }
  | { readonly type: 'saveProfile'; readonly profile: LaunchProfile }
  | { readonly type: 'deleteProfile'; readonly profileId: string }
  | {
      readonly type: 'setKnob';
      readonly key: string;
      readonly value: unknown;
      readonly layer: EditableLayer;
      /** The agent whose settings change. Unset means Claude Code. */
      readonly agent?: AgentId;
    }
  | {
      readonly type: 'openKnobDocs';
      readonly key: string;
      readonly kind: KnobKind;
      /** The agent whose catalog has the key. Unset means Claude Code. */
      readonly agent?: AgentId;
    }
  /** Shows another agent's knobs in the Knobs view. */
  | { readonly type: 'pickKnobsAgent'; readonly agent: AgentId }
  | { readonly type: 'handoff'; readonly sessionId: string; readonly kind: HandoffKind }
  | { readonly type: 'importClaudeAi' }
  | { readonly type: 'syncPush' }
  | { readonly type: 'syncPull' }
  | { readonly type: 'turnOnSync' }
  | { readonly type: 'syncNow' }
  | { readonly type: 'adoptConfig'; readonly itemId: string }
  | { readonly type: 'openFile'; readonly path: string }
  | { readonly type: 'openView'; readonly view: ViewId }
  | { readonly type: 'newAgent' }
  | { readonly type: 'newSkill' }
  | { readonly type: 'browseCatalog'; readonly kind: CatalogKind; readonly source: string }
  | { readonly type: 'searchCatalog'; readonly kind: CatalogKind; readonly query: string }
  | { readonly type: 'openCatalogLink'; readonly kind: CatalogKind; readonly url: string }
  | { readonly type: 'installCatalog'; readonly kind: CatalogKind; readonly entryId: string }
  | { readonly type: 'rescanReputation' }
  | { readonly type: 'uploadReputation' }
  | { readonly type: 'removeReputation' }
  | { readonly type: 'refreshLeaderboard' }
  | { readonly type: 'openLeaderboard' }
  | { readonly type: 'rescanTuning' }
  | { readonly type: 'createSuggestion'; readonly suggestionId: string }
  | { readonly type: 'installPick'; readonly pickId: string }
  | { readonly type: 'openPickLink'; readonly pickId: string }
  | { readonly type: 'trackTip'; readonly tipId: string; readonly on: boolean }
  | { readonly type: 'draftPlan'; readonly goal: string; readonly cwd: string }
  | { readonly type: 'approvePlan'; readonly planId: string }
  | { readonly type: 'discardPlan'; readonly planId: string }
  | { readonly type: 'stopPlan'; readonly planId: string }
  | { readonly type: 'retryPlanTask'; readonly planId: string; readonly taskId: string }
  | { readonly type: 'recheckConnectors' }
  | { readonly type: 'fixConnector'; readonly connectorId: string }
  | { readonly type: 'searchRegistry'; readonly query: string }
  | { readonly type: 'moreRegistry' }
  | { readonly type: 'openRegistryLink'; readonly url: string }
  | {
      readonly type: 'installConnector';
      /** The registry name of the server. */
      readonly server: string;
      /** Which of the server's install options. */
      readonly option: number;
      /** The name to give it in the agent. */
      readonly name: string;
      /** What the user typed, keyed by input id. */
      readonly values: Readonly<Record<string, string>>;
      /** The agent to add it to. Unset means Claude Code. */
      readonly agent?: AgentId;
    }
  | { readonly type: 'setInboundPolicy'; readonly value: string | null }
  | { readonly type: 'newSession'; readonly agent?: AgentId }
  | { readonly type: 'newBridgeChat' }
  | { readonly type: 'landWorktree'; readonly id: string }
  | { readonly type: 'discardWorktree'; readonly id: string }
  | { readonly type: 'openWorktree'; readonly id: string }
  | { readonly type: 'moveSession'; readonly sessionId: string }
  | { readonly type: 'continueInFolder'; readonly sessionId: string }
  | { readonly type: 'newProject'; readonly sessionId: string }
  | { readonly type: 'renameProject'; readonly projectId: string }
  | { readonly type: 'deleteProject'; readonly projectId: string }
  | { readonly type: 'openProjectFolder'; readonly projectId: string }
  | { readonly type: 'setProjectFolder'; readonly projectId: string }
  | { readonly type: 'combineSessions'; readonly sessionId: string }
  | { readonly type: 'renameSession'; readonly sessionId: string }
  /** Set or clear a session's token budget. */
  | { readonly type: 'setBudget'; readonly sessionId: string }
  | { readonly type: 'openProject' }
  | { readonly type: 'newProjectSession'; readonly projectId: string };

export type WebviewToHost =
  | { readonly type: 'ready'; readonly view: ViewId }
  | { readonly type: 'action'; readonly action: WebviewAction };

const VIEW_ID_SET: ReadonlySet<string> = new Set(VIEW_IDS);

export function isViewId(value: unknown): value is ViewId {
  return typeof value === 'string' && VIEW_ID_SET.has(value);
}

/** Narrow an unknown postMessage payload to a WebviewToHost message. */
export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  if (value.type === 'ready') {
    return 'view' in value && isViewId(value.view);
  }
  if (value.type === 'action') {
    if (!('action' in value) || typeof value.action !== 'object' || value.action === null) {
      return false;
    }
    return 'type' in value.action && typeof value.action.type === 'string';
  }
  return false;
}
