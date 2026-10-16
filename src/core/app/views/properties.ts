// The properties panel beside a Claude CLI tab: one session, its subagents
// and anything it is waiting on.

import type { PermissionRequest } from '../../../shared/model.js';
import type { PropertiesState } from '../../../shared/protocol.js';
import type { OverlordStore } from '../../store/store.js';

export function buildProperties(
  store: OverlordStore,
  pending: readonly PermissionRequest[],
  sessionId: string | null,
  pidOf: (sessionId: string) => number | null,
): PropertiesState {
  if (sessionId === null) {
    return { sessionId, session: null, agents: [], pendingPermissions: [] };
  }
  const properties = store.sessionProperties(sessionId);
  // Transcripts do not know the process, so the live one comes from the session registry.
  const pid = pidOf(sessionId);
  return {
    sessionId,
    ...properties,
    session:
      properties.session === null || pid === null
        ? properties.session
        : { ...properties.session, pid },
    pendingPermissions: pending.filter((request) => request.sessionId === sessionId),
  };
}
