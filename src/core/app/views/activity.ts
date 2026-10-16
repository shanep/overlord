// The live sessions the activity view measures, each with the process
// Claude Code runs it in and a title to show.

import os from 'node:os';
import path from 'node:path';

import type { SessionRef } from '../../activity/build.js';
import { ActivityMonitor } from '../../activity/monitor.js';
import type { MachineProbe, Space } from '../../activity/sample.js';
import { defaultStatfs } from '../../activity/sample.js';
import type { OverlordStore } from '../../store/store.js';
import type { CacheRuntime } from '../caches.js';
import type { SessionPlaces } from '../places.js';
import type { IntervalFunction } from '../process.js';

/** Where the machine numbers come from, so tests can pass fixed ones. */
export interface ActivityProbe {
  readonly machine: MachineProbe;
  /** Free and total space on the volume holding a folder. */
  readonly statfs: (target: string) => Promise<Space>;
}

const OS_PROBE: ActivityProbe = {
  machine: {
    cpus: () => os.cpus(),
    loadavg: () => os.loadavg(),
    totalmem: () => os.totalmem(),
  },
  statfs: defaultStatfs,
};

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? '';
}

export function activitySessions(places: SessionPlaces, store: OverlordStore): SessionRef[] {
  return places.liveSessions().map((entry) => {
    const summary = store.sessionProperties(entry.sessionId).session;
    const cwd = firstNonEmpty(entry.cwd, summary?.cwd);
    return {
      sessionId: entry.sessionId,
      pid: entry.pid,
      title: firstNonEmpty(
        summary?.title,
        entry.name,
        cwd === '' ? null : path.basename(cwd),
        entry.sessionId.slice(0, 8),
      ),
      cwd,
      place: places.value[entry.sessionId] ?? null,
    };
  });
}

export function createActivity(
  rt: CacheRuntime,
  interval: IntervalFunction,
  probe: ActivityProbe = OS_PROBE,
): ActivityMonitor {
  return new ActivityMonitor({
    platform: rt.platform,
    exec: rt.exec,
    fs: rt.fs,
    clock: rt.clock,
    delay: rt.delay,
    interval,
    ...probe,
    sessions: () => activitySessions(rt.places, rt.store),
    onChange: rt.notify,
    report: rt.report,
  });
}
