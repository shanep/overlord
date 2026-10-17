// Which Fleet rows are sessions started from the Launcher. Only the Launcher
// starts SDK sessions, and those are the ones whose surface is Overlord.

import type { FleetRow } from './fleet-rows.js';

/** A session row the Launcher started. */
export function isLaunched(row: FleetRow): boolean {
  return row.kind === 'session' && row.surface === 'overlord';
}
