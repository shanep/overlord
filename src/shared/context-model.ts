// Context provenance: which instruction files, memory and skills a session loaded, and why others were skipped.

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
