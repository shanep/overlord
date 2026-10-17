// Usage limit windows the agents report, for the Fleet header and the Usage
// view. Claude Code's 5 hour and 7 day windows already have their own tiles
// and its plan limits come from /usage, so these are the other agents'.

import type { AgentInfo, RateLimitWindow } from '../../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../../src/shared/agents.js';
import { findAgent } from '../agents.js';

export interface NamedWindow {
  readonly key: string;
  /** "Codex 5 hour limit". */
  readonly label: string;
  readonly window: RateLimitWindow;
}

/**
 * Usage limit windows of agents other than Claude Code, whose 5 hour and 7
 * day windows have their own tiles, each with the agent's short name.
 */
export function otherWindows(
  windows: readonly RateLimitWindow[] | undefined,
  agents: readonly AgentInfo[],
): readonly NamedWindow[] {
  return (windows ?? [])
    .filter((window) => window.agent !== CLAUDE_CODE)
    .map((window) => ({
      key: `${window.agent}:${window.id}`,
      label: `${findAgent(agents, window.agent).short} ${window.label} limit`,
      window,
    }));
}
