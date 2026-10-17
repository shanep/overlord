// The coding agent CLIs Overlord can launch and watch, and what each one
// lets the UI offer. Plain data so it can cross postMessage.

/** Known ids get constants; custom ACP agents use their own string. */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- the name says which string a field holds
export type AgentId = string;
export const CLAUDE_CODE: AgentId = 'claude-code';
/** @public */
export const CODEX: AgentId = 'codex';
/** @public */
export const COPILOT: AgentId = 'copilot';

export interface ModeOption {
  /** What we pass to the agent. */
  readonly id: string;
  /** What the UI shows. */
  readonly label: string;
  /** Yolo, bypass, danger-full-access. */
  readonly risky?: boolean;
}

/** What the UI may offer for sessions of this agent. */
export interface AgentCapabilities {
  /** The Launcher can run it programmatically. */
  readonly launch: boolean;
  /** It can open in a terminal tab. */
  readonly terminal: boolean;
  /** Detached runs, like claude --bg. */
  readonly background: boolean;
  readonly resume: boolean;
  readonly fork: boolean;
  readonly interrupt: boolean;
  readonly liveModelChange: boolean;
  readonly livePermissionMode: boolean;
  /** The permission inbox works. */
  readonly approvals: boolean;
  readonly subagents: boolean;
  readonly cacheReads: boolean;
  readonly cacheWrites: boolean;
  /** The agent or a price table gives dollars. */
  readonly costUsd: boolean;
  readonly contextInspector: boolean;
  /** Coordination notes reach it. */
  readonly hooks: boolean;
  /** Cross-session messages. */
  readonly messaging: boolean;
  /** For Claude: desktop, teleport and the rest. */
  readonly handoffs: readonly string[];
}

/** Sent to the webview once per state update. */
export interface AgentInfo {
  readonly id: AgentId;
  /** "Claude Code", "Codex CLI". */
  readonly name: string;
  /** "Claude", "Codex", used in "Continue in Codex". */
  readonly short: string;
  /** A codicon id. */
  readonly icon: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly capabilities: AgentCapabilities;
  readonly permissionModes: readonly ModeOption[];
  readonly effortLevels: readonly ModeOption[];
}

/** One usage limit window, such as Claude's 5 hour one. */
export interface RateLimitWindow {
  readonly agent: AgentId;
  /** The agent's own id for the window, such as five_hour. */
  readonly id: string;
  /** "5 hour", "7 day", "30 day". */
  readonly label: string;
  /** Percent on the bus, 0 to 1 in view state. */
  readonly usedPct: number | null;
  readonly resetsAt: number | null;
}
