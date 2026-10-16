// The properties panel beside a Claude CLI tab: one session, its subagents
// and anything it is waiting on.

import type { PermissionRequest } from '../../../shared/model.js';
import type { PropertiesState } from '../../../shared/protocol.js';
import type { OverlordStore } from '../../store/store.js';

export function buildProperties(
  store: OverlordStore,
  pending: readonly PermissionRequest[],
  sessionId: string | null,
): PropertiesState {
  if (sessionId === null) {
    return { sessionId, session: null, agents: [], pendingPermissions: [] };
  }
  return {
    sessionId,
    ...store.sessionProperties(sessionId),
    pendingPermissions: pending.filter((request) => request.sessionId === sessionId),
  };
}
