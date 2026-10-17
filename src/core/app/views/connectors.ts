// The Connectors view and the connector note new sessions get. The check runs
// in the background through the connectors cache: on first use, every
// CONNECTORS_REFRESH_MS after start, and when Recheck is pressed. The hook
// reply reads the last result and never waits on a check.

import type { AgentId } from '../../../shared/agents.js';
import { CLAUDE_CODE } from '../../../shared/agents.js';
import type { ConnectorsState } from '../../../shared/connectors.js';
import { connectorsFor } from '../../../shared/connectors.js';
import { connectorBriefing } from '../../connectors/briefing.js';
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
 * The SessionStart note for a session of the agent, from the last check, with
 * only the rows that agent can reach. Reading it starts the first check.
 */
export function sessionBriefing(rt: Runtime, agent: AgentId = CLAUDE_CODE): string {
  const { value } = rt.caches.connectors;
  return connectorBriefing(
    { checkedAt: value.checkedAt, connectors: connectorsFor(agent, value.connectors) },
    clockTime,
  );
}

/** Checks again now, showing the view as checking while it runs. */
export async function recheckConnectors(rt: Runtime): Promise<void> {
  const done = rt.caches.connectors.refresh();
  rt.notify();
  await done;
}
