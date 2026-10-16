// The properties panel beside a Claude CLI tab: one session, its subagents,
// anything it is waiting on and how healthy it looks.

import type { PermissionRequest } from '../../../shared/model.js';
import type { PropertiesState } from '../../../shared/protocol.js';
import { assessHealth } from '../../health/health.js';
import type { OverlordStore } from '../../store/store.js';

export function buildProperties(
  store: OverlordStore,
  pending: readonly PermissionRequest[],
  sessionId: string | null,
  pidOf: (sessionId: string) => number | null,
): PropertiesState {
  if (sessionId === null) {
    return { sessionId, session: null, agents: [], pendingPermissions: [], health: null };
  }
  const properties = store.sessionProperties(sessionId);
  const { session } = properties;
  // Transcripts do not know the process, so the live one comes from the session registry.
  const pid = pidOf(sessionId);
  return {
    sessionId,
    ...properties,
    session: session === null || pid === null ? session : { ...session, pid },
    pendingPermissions: pending.filter((request) => request.sessionId === sessionId),
    health:
      session === null
        ? null
        : assessHealth({
            startedAt: session.startedAt,
            updatedAt: session.updatedAt,
            ...store.agentActivity(sessionId, sessionId),
          }),
  };
}
