// Usage limit windows the agents report, for the Fleet header and the Usage
// view. Claude Code's 5 hour and 7 day windows already have their own tiles
// and its plan limits come from /usage, so these are the other agents'.

import type { AgentId, AgentInfo, RateLimitWindow } from '../../../src/shared/agents.js';
import { CLAUDE_CODE, CODEX, COPILOT } from '../../../src/shared/agents.js';
import { findAgent, knownAgents } from '../agents.js';

export interface NamedWindow {
  readonly key: string;
  /** "Codex 5 hour limit", the accessible name. */
  readonly label: string;
  /** "5 hour limit". The agent's icon goes beside it, so it leaves the name out. */
  readonly title: string;
  readonly agent: AgentInfo;
  readonly window: RateLimitWindow;
}

/**
 * A tile per agent until its first report, under the id that report uses.
 * Codex's windows depend on the plan (5 hour and 7 day, or one 30 day), so
 * its placeholder does not guess at a length.
 */
const EXPECTED: Readonly<
  Record<AgentId, readonly { readonly id: string; readonly label: string }[]>
> = {
  [CODEX]: [{ id: 'primary', label: 'Plan' }],
  [COPILOT]: [{ id: 'premium_interactions', label: 'Monthly' }],
};

/**
 * A window whose reset time has passed has started over, so it shows as
 * unused until a session reports it again.
 */
function current(window: RateLimitWindow, now: number): RateLimitWindow {
  return window.resetsAt !== null && window.resetsAt <= now
    ? { ...window, usedPct: window.usedPct === null ? null : 0, resetsAt: null }
    : window;
}

/** Empty windows for installed agents that have not reported theirs yet. */
function placeholders(
  reported: readonly RateLimitWindow[],
  agents: readonly AgentInfo[],
): RateLimitWindow[] {
  return knownAgents(agents)
    .filter((agent) => agent.installed && !reported.some((window) => window.agent === agent.id))
    .flatMap((agent) =>
      (EXPECTED[agent.id] ?? []).map(({ id, label }) => ({
        agent: agent.id,
        id,
        label,
        usedPct: null,
        resetsAt: null,
      })),
    );
}

/**
 * Usage limit windows of agents other than Claude Code, whose 5 hour and 7
 * day windows have their own tiles, with an empty one for each window an
 * installed agent has not reported yet.
 */
export function otherWindows(
  windows: readonly RateLimitWindow[] | undefined,
  agents: readonly AgentInfo[],
  now: number,
): readonly NamedWindow[] {
  const reported = (windows ?? []).filter((window) => window.agent !== CLAUDE_CODE);
  return [...reported, ...placeholders(reported, agents)].map((window) => {
    const agent = findAgent(agents, window.agent);
    return {
      key: `${window.agent}:${window.id}`,
      label: `${agent.short} ${window.label} limit`,
      title: `${window.label} limit`,
      agent,
      window: current(window, now),
    };
  });
}
