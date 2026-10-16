// Actions for the tips view.

import { renderAgent, renderSkill } from '../authoring/render.js';
import { findSuggestion, nameOf } from '../tips/suggestions.js';
import { plural } from '../tips/words.js';

import type { ActionHandlers } from './action-types.js';
import { saveAuthored } from './actions-authoring.js';
import { refreshInstalled, rescanTips } from './views/tips.js';

export const tipsActions: ActionHandlers<'rescanTips' | 'createSuggestion'> = {
  rescanTips: async ({ rt }) => {
    const state = await rescanTips(rt);
    rt.host.showInfo(
      `Tips rescan done: ${plural(state.sessions, 'session')}, ${plural(state.tips.length, 'tip')}.`,
    );
  },
  createSuggestion: async ({ rt }, action) => {
    const definition = findSuggestion(action.suggestionId);
    if (definition === null) {
      rt.host.showError(`There is no suggestion called ${action.suggestionId}.`);
      return;
    }
    const text =
      definition.kind === 'agent' ? renderAgent(definition.spec) : renderSkill(definition.spec);
    if (await saveAuthored(rt, definition.kind, { name: nameOf(definition), text })) {
      await refreshInstalled(rt);
    }
  },
};
