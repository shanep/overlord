// Actions for the Tuning view.

import { renderAgent, renderSkill } from '../authoring/render.js';
import { isTipId } from '../tuning/build.js';
import { findSuggestion, nameOf } from '../tuning/suggestions.js';
import { plural } from '../tuning/words.js';

import type { ActionHandlers } from './action-types.js';
import { saveAuthored } from './actions-authoring.js';
import { refreshInstalled, rescanTuning, setTipTracked, trackAdviceTaken } from './views/tuning.js';

export const tuningActions: ActionHandlers<'rescanTuning' | 'createSuggestion' | 'trackTip'> = {
  rescanTuning: async ({ rt }) => {
    const [state] = await Promise.all([rescanTuning(rt), rt.caches.plan.refresh()]);
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
