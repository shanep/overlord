// The Connectors view and the connector note new sessions get. The check runs
// in the background through the connectors cache: on first use, every
// CONNECTORS_REFRESH_MS after start, and when Recheck is pressed. The hook
// reply reads the last result and never waits on a check.

import type { AgentId } from '../../../shared/agents.js';
import { CLAUDE_CODE } from '../../../shared/agents.js';
import type { ConnectorsState } from '../../../shared/connectors.js';
import { connectorsFor } from '../../../shared/connectors.js';
import { agents } from '../../agents/index.js';
import { checkRule, connectorBriefing } from '../../connectors/briefing.js';
import { progressRule } from '../../progress/briefing.js';
import type { Runtime } from '../runtime.js';

export const CONNECTORS_REFRESH_MS = 10 * 60 * 1000;

/** The view's state. Opening it the first time also starts browsing the registry. */
export function buildConnectors(rt: Runtime): ConnectorsState {
  const { connectors } = rt.caches;
  rt.registry.start();
  return { ...connectors.value, checking: connectors.loading, registry: rt.registry.view() };
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * The SessionStart note for a session of the agent, in its words: the
 * connectors from the last check, with only the rows that agent can reach,
 * then the ask to keep its task list whole when Overlord reads that list.
 * Reading it starts the first check.
 */
export function sessionBriefing(rt: Runtime, agent: AgentId = CLAUDE_CODE): string {
  const { value } = rt.caches.connectors;
  const adapter = agents.get(agent);
  const words = adapter?.words;
  const subagents = adapter?.capabilities.subagents ?? false;
  const connectors = connectorBriefing(
    { checkedAt: value.checkedAt, connectors: connectorsFor(agent, value.connectors) },
    clockTime,
    checkRule({ examples: words?.connectorExamples ?? null, subagents }),
  );
  const taskList = words?.taskList ?? null;
  return taskList === null ? connectors : `${connectors}\n\n${progressRule(taskList, subagents)}`;
}

/** Checks again now, showing the view as checking while it runs. */
export async function recheckConnectors(rt: Runtime): Promise<void> {
  const done = rt.caches.connectors.refresh();
  rt.notify();
  await done;
}
