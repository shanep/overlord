// Actions for the tips view.

import { renderAgent, renderSkill } from '../authoring/render.js';
import { isTipId } from '../tips/build.js';
import { findSuggestion, nameOf } from '../tips/suggestions.js';
import { plural } from '../tips/words.js';

import type { ActionHandlers } from './action-types.js';
import { saveAuthored } from './actions-authoring.js';
import { refreshInstalled, rescanTips, setTipTracked, trackAdviceTaken } from './views/tips.js';

export const tipsActions: ActionHandlers<'rescanTips' | 'createSuggestion' | 'trackTip'> = {
  rescanTips: async ({ rt }) => {
    const state = await rescanTips(rt);
    rt.host.showInfo(
      `Tuning rescan done: ${plural(state.sessions, 'session')}, ${plural(state.tips.length, 'tip')}.`,
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
      await trackAdviceTaken(rt, { kind: 'suggestion', id: definition.id });
    }
  },
  trackTip: async ({ rt }, action) => {
    if (!isTipId(action.tipId)) {
      rt.host.showError(`There is no tip called ${action.tipId}.`);
      return;
    }
    await setTipTracked(rt, action.tipId, action.on);
  },
};
