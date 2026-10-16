// The Connectors view and the connector note new sessions get. The check runs
// in the background through the connectors cache: on first use, every
// CONNECTORS_REFRESH_MS after start, and when Recheck is pressed. The hook
// reply reads the last result and never waits on a check.

import type { ConnectorsState } from '../../../shared/connectors.js';
import { connectorBriefing } from '../../connectors/briefing.js';
import type { Runtime } from '../runtime.js';

export const CONNECTORS_REFRESH_MS = 10 * 60 * 1000;

export function buildConnectors(rt: Runtime): ConnectorsState {
  const { connectors } = rt.caches;
  return { ...connectors.value, checking: connectors.loading };
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** The SessionStart note, from the last check. Reading it starts the first check. */
export function sessionBriefing(rt: Runtime): string {
  return connectorBriefing(rt.caches.connectors.value, clockTime);
}

/** Checks again now, showing the view as checking while it runs. */
export async function recheckConnectors(rt: Runtime): Promise<void> {
  const done = rt.caches.connectors.refresh();
  rt.notify();
  await done;
}
