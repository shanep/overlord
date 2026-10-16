// Actions for the reputation view.

import type { ActionHandlers } from './action-types.js';
import { rescanReputation } from './views/reputation.js';

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

export const reputationActions: ActionHandlers<'rescanReputation'> = {
  rescanReputation: async ({ rt }) => {
    const state = await rescanReputation(rt);
    rt.host.showInfo(
      `Reputation rescan done: ${plural(state.prompts, 'prompt')}, ${state.kind.toLocaleString('en-US')} kind, ${state.mean.toLocaleString('en-US')} mean to Claude.`,
    );
  },
};
