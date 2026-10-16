// Typed messages between the extension host and the webviews. Every message
// is plain JSON. The host sends a full `state` for the active view and then
// `patch` messages as data changes. The webview sends `ready` once and then
// `action` messages for user intent.

import type {
  AgentNode,
  ApiRequest,
  ConfigItem,
  ContextSnapshot,
  DailyUsage,
  EffectiveValue,
  FeedItem,
  KnobDefinition,
  LaunchProfile,
  LaunchSpec,
  PermissionDecision,
  PermissionRequest,
  SessionPlace,
  SessionSummary,
  ToolCall,
} from './model.js';

export type ViewId =
  | 'fleet'
  | 'agent'
  | 'context'
  | 'knobs'
  | 'launcher'
  | 'sessions'
  | 'config'
  | 'usage'
  | 'frustration'
  | 'messages'
  | 'properties';

export const VIEW_IDS: readonly ViewId[] = [
  'fleet',
  'agent',
  'context',
  'knobs',
  'launcher',
  'sessions',
  'config',
  'usage',
  'frustration',
  'messages',
  'properties',
];

export interface RateLimits {
  readonly fiveHourPct: number | null;
  readonly sevenDayPct: number | null;
  readonly resetsAt: number | null;
}

export interface FleetState {
  readonly sessions: readonly SessionSummary[];
  readonly agents: readonly AgentNode[];
  readonly pendingPermissions: readonly PermissionRequest[];
  /** Where each session with a live process runs, by session id. */
  readonly places: Readonly<Record<string, SessionPlace>>;
  readonly rateLimits: RateLimits;
  /** Spend per hour over the last hour, all sessions. */
  readonly spendPerHourUsd: number;
}

export interface AgentDetailState {
  readonly agent: AgentNode | null;
  readonly session: SessionSummary | null;
  readonly children: readonly AgentNode[];
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
}

export interface ContextState {
  readonly snapshot: ContextSnapshot | null;
  readonly sessions: readonly { readonly id: string; readonly title: string }[];
}

export interface KnobsState {
  readonly catalog: readonly KnobDefinition[];
  readonly effective: readonly EffectiveValue[];
  readonly profiles: readonly LaunchProfile[];
  /** Cached server feature flags, read-only. */
  readonly featureFlags: Readonly<Record<string, unknown>>;
}

export interface LaunchRun {
  readonly id: string;
  readonly batchId: string;
  readonly spec: LaunchSpec;
  readonly sessionId: string | null;
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  readonly costUsd: number;
  readonly turns: number;
  readonly durationMs: number;
  readonly result: string | null;
  readonly worktreePath: string | null;
}

export interface AutoApproveRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly behavior: 'allow' | 'deny';
  /** Tool name pattern, for example "Bash" or "mcp__github__*". */
  readonly tool: string;
  /** Optional pattern on the command (Bash) or path (file tools). */
  readonly pattern: string | null;
  readonly description: string;
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
}

export interface SurfaceSession {
  readonly id: string;
  readonly surface: SessionSummary['surface'];
  readonly title: string;
  readonly cwd: string | null;
  readonly updatedAt: number;
  readonly archived: boolean;
  /** Handoffs this session supports right now. */
  readonly handoffs: readonly HandoffKind[];
}

export type HandoffKind =
  'resume-local' | 'open-desktop' | 'teleport-local' | 'start-cloud' | 'remote-control';

export interface SessionsState {
  readonly sessions: readonly SurfaceSession[];
  readonly claudeAiImportedAt: number | null;
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
}

export interface UsageStats {
  readonly days: readonly DailyUsage[];
  readonly hourCounts: Readonly<Record<string, number>>;
  readonly totalSessions: number;
  readonly totalMessages: number;
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
}

/** One user prompt with abusive or frustrated language in it. */
export interface FrustrationHit {
  readonly id: string;
  readonly sessionId: string;
  readonly at: number;
  /** The words or phrases that matched. */
  readonly terms: readonly string[];
  /** Aimed at Claude ("you", "your", direct insults) or general swearing. */
  readonly target: 'claude' | 'general';
  /** A short excerpt around the first match. */
  readonly excerpt: string;
}

export interface FrustrationState {
  readonly totalPrompts: number;
  readonly atClaude: number;
  readonly general: number;
  readonly byDay: readonly {
    readonly date: string;
    readonly prompts: number;
    readonly atClaude: number;
    readonly general: number;
  }[];
  readonly bySession: readonly {
    readonly sessionId: string;
    readonly title: string;
    readonly prompts: number;
    readonly hits: number;
  }[];
  readonly topTerms: readonly { readonly term: string; readonly count: number }[];
  readonly recent: readonly FrustrationHit[];
  /** When the counts were last rebuilt from transcripts, or null before the first scan. */
  readonly scannedAt: number | null;
}

/** One message between agents or sessions, from the transcripts. */
export interface AgentMessage {
  readonly id: string;
  readonly at: number;
  readonly sessionId: string;
  /** Who sent it: an agent name, agent id, "main", or a session id. */
  readonly from: string;
  readonly to: string;
  readonly kind: 'send' | 'receive' | 'broadcast' | 'task-notification' | 'hand-back';
  readonly preview: string;
  /** True when a rule or hook stopped it. */
  readonly blocked: boolean;
}

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

interface ViewStateMap {
  readonly fleet: FleetState;
  readonly agent: AgentDetailState;
  readonly context: ContextState;
  readonly knobs: KnobsState;
  readonly launcher: LauncherState;
  readonly sessions: SessionsState;
  readonly config: ConfigState;
  readonly usage: UsageState;
  readonly frustration: FrustrationState;
  readonly messages: MessagesState;
  readonly properties: PropertiesState;
}

export type HostToWebview = {
  readonly [V in ViewId]: {
    readonly type: 'state';
    readonly view: V;
    readonly state: ViewStateMap[V];
  };
}[ViewId];

export type WebviewAction =
  | { readonly type: 'openSession'; readonly sessionId: string }
  | { readonly type: 'openAgent'; readonly sessionId: string; readonly agentId: string }
  | { readonly type: 'openContext'; readonly sessionId: string; readonly agentId: string | null }
  | { readonly type: 'interrupt'; readonly sessionId: string }
  | { readonly type: 'stop'; readonly sessionId: string }
  | { readonly type: 'attach'; readonly sessionId: string }
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
  | { readonly type: 'saveRule'; readonly rule: AutoApproveRule }
  | { readonly type: 'deleteRule'; readonly ruleId: string }
  | { readonly type: 'saveProfile'; readonly profile: LaunchProfile }
  | {
      readonly type: 'setKnob';
      readonly key: string;
      readonly value: unknown;
      readonly layer: 'user' | 'project' | 'project-local';
    }
  | { readonly type: 'handoff'; readonly sessionId: string; readonly kind: HandoffKind }
  | { readonly type: 'importClaudeAi' }
  | { readonly type: 'syncPush' }
  | { readonly type: 'syncPull' }
  | { readonly type: 'adoptConfig'; readonly itemId: string }
  | { readonly type: 'openFile'; readonly path: string }
  | { readonly type: 'newAgent' }
  | { readonly type: 'newSkill' }
  | { readonly type: 'rescanFrustration' }
  | { readonly type: 'setInboundPolicy'; readonly value: string | null };

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
