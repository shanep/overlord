// Which Fleet rows are sessions started from the Launcher. The host keeps the
// list, since a launched session's transcript reports the SDK as its surface.

import type { FleetRow } from './fleet-rows.js';

/** A session row the Launcher started. */
export function isLaunched(row: FleetRow): boolean {
  return row.kind === 'session' && row.launched;
}
