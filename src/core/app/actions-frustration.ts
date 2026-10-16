// Actions for the frustration view.

import type { ActionHandlers } from './action-types.js';
import { rescanFrustration } from './views/frustration.js';

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

export const frustrationActions: ActionHandlers<'rescanFrustration'> = {
  rescanFrustration: async ({ rt }) => {
    const state = await rescanFrustration(rt);
    const hits = state.atClaude + state.general;
    rt.host.showInfo(
      `Frustration rescan done: ${plural(state.totalPrompts, 'prompt')}, ${plural(hits, 'hit')} (${state.atClaude.toLocaleString('en-US')} aimed at Claude, ${state.general.toLocaleString('en-US')} general).`,
    );
  },
};
