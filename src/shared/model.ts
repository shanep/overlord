// Normalized entities shared by the extension host and the webviews.
// Everything here is plain data (JSON safe) so it can cross postMessage.
// Times are epoch milliseconds.

/** Where a session runs or came from. */
export type Surface =
  'cli' | 'sdk' | 'overlord' | 'desktop-code' | 'cowork' | 'cloud' | 'claude-ai';

export type SessionState = 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'unknown';

/**
 * Where a live Claude Code process runs: a terminal in this VS Code window,
 * a terminal anywhere else, or in the background with no terminal at all.
 */
export type SessionPlace = 'vscode' | 'terminal' | 'background';

export type PermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions' | 'manual';

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly thinking: number;
}

export const ZERO_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  thinking: 0,
};

/** One row in the fleet view. */
/** Claude Code's own recap of a session, written when the user comes back to it. */
export interface SessionRecap {
  readonly text: string;
  readonly at: number;
}

export interface SessionSummary {
  readonly id: string;
  readonly surface: Surface;
  readonly title: string;
  readonly cwd: string;
  readonly state: SessionState;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly usage: TokenUsage;
  /** Client-side estimate at list price, not billing. */
  readonly costUsd: number | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: PermissionMode | null;
  readonly pid: number | null;
  readonly transcriptPath: string | null;
  readonly gitBranch: string | null;
  readonly version: string | null;
  /** Number of subagents seen in this session, all depths. */
  readonly agentCount: number;
  /** Context window fill, 0 to 1, when known. */
  readonly contextFill: number | null;
  /** Claude Code's newest recap, or null before it writes one. */
  readonly recap: SessionRecap | null;
  /** The newest prompt the user typed, as Claude Code saved it (cut short when long). */
  readonly lastPrompt: string | null;
  /** When the user typed it, so a recap written before it reads as out of date. */
  readonly lastPromptAt: number | null;
}

/** A main thread or a subagent. The main thread has `parentAgentId` null and `id` equal to the session id. */
export interface AgentNode {
  readonly id: string;
  readonly sessionId: string;
  readonly parentAgentId: string | null;
  /** Tool use id of the Agent call in the parent that started this agent. */
  readonly parentToolUseId: string | null;
  readonly agentType: string;
  readonly description: string;
  readonly spawnDepth: number;
  readonly background: boolean;
  readonly state: SessionState;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly transcriptPath: string | null;
  readonly usage: TokenUsage;
  readonly toolCallCount: number;
  readonly currentTool: string | null;
  readonly model: string | null;
}

export interface ToolCall {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly name: string;
  readonly input: unknown;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly ok: boolean | null;
  /** First part of the result text, for the feed. */
  readonly resultPreview: string | null;
}

/** One model API call, deduplicated by message id. */
export interface ApiRequest {
  readonly messageId: string;
  readonly requestId: string | null;
  readonly sessionId: string;
  readonly agentId: string;
  readonly model: string;
  readonly timestamp: number;
  readonly usage: TokenUsage;
  readonly ttftMs: number | null;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
}

export type FeedItem =
  | { readonly kind: 'user'; readonly id: string; readonly at: number; readonly text: string }
  | { readonly kind: 'text'; readonly id: string; readonly at: number; readonly text: string }
  | { readonly kind: 'thinking'; readonly id: string; readonly at: number; readonly text: string }
  | {
      readonly kind: 'tool_use';
      readonly id: string;
      readonly at: number;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly kind: 'tool_result';
      readonly id: string;
      readonly at: number;
      readonly toolUseId: string;
      readonly ok: boolean;
      readonly text: string;
    }
  | { readonly kind: 'system'; readonly id: string; readonly at: number; readonly text: string };

// ---- Context provenance -------------------------------------------------

export type MemoryTier = 'Managed' | 'User' | 'Project' | 'Local' | 'AutoMem';

export type LoadReason =
  'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact' | 'unknown';

export interface LoadedInstruction {
  readonly path: string;
  readonly tier: MemoryTier;
  readonly reason: LoadReason;
  /** For lazy loads, the file access that triggered it. */
  readonly triggerPath: string | null;
  /** For @imports, the file that imported this one. */
  readonly parentPath: string | null;
  readonly globs: readonly string[];
  readonly bytes: number;
  /** True when the loaded text no longer matches the file on disk. */
  readonly differsFromDisk: boolean | null;
  readonly loadedAt: number | null;
}

export type SkipReasonCode =
  | 'missing'
  | 'excluded'
  | 'lazy-not-touched'
  | 'glob-not-matched'
  | 'import-too-deep'
  | 'import-in-code'
  | 'external-import-unapproved'
  | 'agents-md-shadowed'
  | 'add-dir-without-env'
  | 'memory-truncated'
  | 'auto-memory-disabled'
  | 'claude-md-disabled'
  | 'setting-source-excluded'
  | 'omit-claude-md'
  | 'not-passed-to-subagent';

export interface SkippedCandidate {
  readonly path: string;
  readonly tier: MemoryTier;
  readonly exists: boolean;
  readonly code: SkipReasonCode;
  /** One plain sentence, for example "Excluded by claudeMdExcludes pattern ** /vendor/** in user settings." */
  readonly detail: string;
}

export interface SkillEntry {
  readonly name: string;
  readonly source: 'user' | 'project' | 'plugin' | 'managed' | 'claude-ai' | 'built-in' | 'unknown';
  readonly path: string | null;
  readonly listed: boolean;
  readonly invoked: boolean;
  readonly descriptionChars: number;
}

export interface ContextSnapshot {
  readonly sessionId: string;
  readonly agentId: string;
  readonly at: number;
  readonly systemPrompt: readonly string[] | null;
  readonly model: string | null;
  readonly loaded: readonly LoadedInstruction[];
  readonly skipped: readonly SkippedCandidate[];
  readonly skills: readonly SkillEntry[];
  readonly agentTypes: readonly string[];
  readonly mcpServers: readonly { readonly name: string; readonly instructions: string }[];
  readonly deferredTools: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  /** Token weight per category when known (from getContextUsage or estimated). */
  readonly weights: readonly {
    readonly label: string;
    readonly tokens: number;
    readonly estimated: boolean;
  }[];
}

// ---- Knobs --------------------------------------------------------------

export type KnobKind = 'setting' | 'env' | 'flag';
export type KnobValueType = 'boolean' | 'number' | 'string' | 'enum' | 'json' | 'string[]';
export type AppliesAt = 'live' | 'next-turn' | 'next-launch';

export interface KnobDefinition {
  readonly key: string;
  readonly kind: KnobKind;
  readonly area: string;
  readonly valueType: KnobValueType;
  readonly defaultValue: string | null;
  readonly allowed: readonly string[];
  readonly description: string;
  readonly docUrl: string;
  readonly appliesAt: AppliesAt;
  readonly managedOnly: boolean;
}

export type SettingsLayer =
  'managed' | 'cli' | 'project-local' | 'project' | 'user' | 'env' | 'default';

export interface EffectiveValue {
  readonly key: string;
  readonly value: unknown;
  readonly layer: SettingsLayer;
  /** Every layer that set this key, highest precedence first, including the winner. */
  readonly chain: readonly {
    readonly layer: SettingsLayer;
    readonly value: unknown;
    readonly file: string | null;
  }[];
}

// ---- Config inventory and sync -----------------------------------------

export type ConfigKind =
  | 'claude-md'
  | 'settings'
  | 'rule'
  | 'skill'
  | 'agent'
  | 'command'
  | 'output-style'
  | 'hook'
  | 'mcp-server'
  | 'plugin'
  | 'memory'
  | 'keybindings';

export type ConfigScope =
  'managed' | 'user' | 'project' | 'local' | 'plugin' | 'built-in' | 'cloud';

export type ConfigStatus =
  | 'versioned'
  | 'modified'
  | 'external-repo'
  | 'local-only'
  | 'cloud-synced'
  | 'plugin'
  | 'managed'
  | 'built-in'
  | 'secret';

export interface ConfigItem {
  readonly id: string;
  readonly kind: ConfigKind;
  readonly name: string;
  readonly scope: ConfigScope;
  readonly path: string | null;
  /** Symlink target, when the path is a link. */
  readonly realPath: string | null;
  readonly status: ConfigStatus;
  readonly repo: {
    readonly root: string;
    readonly remote: string | null;
    readonly dirty: boolean;
  } | null;
}

// ---- Harness ------------------------------------------------------------

export interface PermissionRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly requestedAt: number;
  readonly source: 'sdk' | 'hook';
}

export type PermissionDecision =
  | { readonly behavior: 'allow'; readonly ruleId: string | null }
  | { readonly behavior: 'deny'; readonly message: string; readonly ruleId: string | null };

export interface LaunchProfile {
  readonly id: string;
  readonly name: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: PermissionMode | null;
  readonly env: Readonly<Record<string, string>>;
  readonly extraArgs: readonly string[];
}

export interface LaunchSpec {
  readonly prompt: string;
  readonly cwd: string;
  readonly profileId: string | null;
  readonly worktree: boolean;
  readonly maxBudgetUsd: number | null;
  readonly label: string;
}

// ---- Usage history ------------------------------------------------------

export interface DailyUsage {
  readonly date: string;
  readonly messages: number;
  readonly sessions: number;
  readonly toolCalls: number;
  readonly tokensByModel: Readonly<Record<string, number>>;
}
