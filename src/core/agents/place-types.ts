// Where an agent keeps its files, and the shell environment it runs with.

import type { ClaudePaths } from '../paths.js';

/** The environment to look for binaries in, usually the login shell's. */
export type ShellEnv = Readonly<Record<string, string | undefined>>;

/**
 * Where an agent keeps its files, as the observer, the instruction policy,
 * the MCP list and the library look for them. Each agent finds its own
 * folder from these: Claude Code from claude, Codex and Copilot from a
 * variable in env or a folder under home.
 */
export interface AgentPlace {
  readonly home: string;
  /** Variables that move an agent's folders, like CLAUDE_CONFIG_DIR, CODEX_HOME or COPILOT_HOME. */
  readonly env: ShellEnv;
  /** Claude Code's folders as the app resolved them. Only Claude Code's facets read these. */
  readonly claude: ClaudePaths;
}
