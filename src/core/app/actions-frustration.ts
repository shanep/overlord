// Actions for the frustration view. Owned by the frustration work.

import type { ActionHandlers } from './action-types.js';

export const frustrationActions: ActionHandlers<'rescanFrustration'> = {
  rescanFrustration: async ({ rt }) => {
    rt.host.showInfo('Frustration scanning is not ready yet.');
    await Promise.resolve();
  },
};
