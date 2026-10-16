// Actions for the agent messages view. Owned by the messaging work.

import type { ActionHandlers } from './action-types.js';

export const messageActions: ActionHandlers<'setInboundPolicy'> = {
  setInboundPolicy: async ({ rt }) => {
    rt.host.showInfo('Message controls are not ready yet.');
    await Promise.resolve();
  },
};
