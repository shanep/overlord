// Auto-approve rules as the host saves them and the Launcher shows them.

import type { AgentId } from './agents.js';

export interface AutoApproveRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly behavior: 'allow' | 'deny';
  /** Tool name pattern, for example "Bash" or "mcp__github__*". */
  readonly tool: string;
  /** Optional pattern on the command (Bash) or path (file tools). */
  readonly pattern: string | null;
  readonly description: string;
  /**
   * The agent whose requests the rule answers, or ALL_AGENTS for every one.
   * Unset means Claude Code, since rules saved before this field only ever
   * saw Claude's requests.
   */
  readonly agent?: AgentId;
}

/** The rule scope that covers every agent. */
export const ALL_AGENTS = '*';
