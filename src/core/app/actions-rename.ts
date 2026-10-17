// Renaming a session from its fleet row. The name goes where Claude Code
// keeps it, so the fleet, /resume and the terminal tab all show it.

import { sessionName } from '../../shared/model.js';
import { saveSessionTitle } from '../transcripts/rename.js';

import type { ActionHandlers } from './action-types.js';
import { messageOf } from './errors.js';
import { fleetFor } from './views/fleet.js';

export const NO_TRANSCRIPT = 'That session has no transcript to name yet. Send it a prompt first.';

export const renameActions: ActionHandlers<'renameSession'> = {
  renameSession: async ({ rt }, action) => {
    const session = fleetFor(rt).sessions.find((item) => item.id === action.sessionId);
    if (session === undefined || session.transcriptPath === null) {
      rt.host.showInfo(NO_TRANSCRIPT);
      return;
    }
    const current = sessionName(session);
    const answer = await rt.host.inputBox({ prompt: 'Session name', value: current });
    const name = answer?.replaceAll(/\s+/gu, ' ').trim() ?? '';
    if (name === '' || name === current) {
      return;
    }
    try {
      await saveSessionTitle(session.transcriptPath, session.id, name);
    } catch (error) {
      rt.host.showError(`Could not rename the session: ${messageOf(error)}`);
    }
  },
};
