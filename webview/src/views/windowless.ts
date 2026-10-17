// Which Fleet rows get the hourglass: quiet sessions no terminal shows, which
// the fleet lets go in time because nothing holds them there. Launched
// and unfinished sessions stay until removed by hand, so they never get it.

import type { FleetRow } from './fleet-rows.js';

const QUIET = new Set(['idle', 'done']);

/** A quiet session row open in no terminal, so it leaves the fleet in time. */
export function isWindowless(row: FleetRow): boolean {
  const viewed = row.place === 'vscode' || row.place === 'terminal';
  return row.kind === 'session' && QUIET.has(row.state) && !viewed && !row.launched;
}
