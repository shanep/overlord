// Which Fleet rows are sessions started from the Launcher. The host keeps the
// list, since a launched session's transcript reports the SDK as its surface.

import type { FleetRow } from './fleet-rows.js';

/** A session row the Launcher started. */
export function isLaunched(row: FleetRow): boolean {
  return row.kind === 'session' && row.launched;
}

/**
 * A session row Remove takes out of the fleet: one the Launcher started, a
 * failed background job, which stays until it is deleted, or an unfinished
 * session, which stays until you look at it.
 */
export function isRemovable(row: FleetRow): boolean {
  return (
    isLaunched(row) ||
    (row.kind === 'session' && (row.state === 'failed' || row.state === 'unfinished'))
  );
}
