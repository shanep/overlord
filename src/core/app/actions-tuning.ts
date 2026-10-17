// Actions for the Tuning view.

import { renderAgent, renderSkill } from '../authoring/render.js';
import { isTipId } from '../tuning/build.js';
import { findSuggestion, nameOf } from '../tuning/suggestions.js';
import { plural } from '../tuning/words.js';

import type { ActionHandlers } from './action-types.js';
import { saveAuthored } from './actions-authoring.js';
import { installEntry } from './actions-catalog.js';
import { messageOf } from './errors.js';
import {
  refreshInstalled,
  rescanTuning,
  setTipTracked,
  trackAdviceTaken,
  tuningPicks,
} from './views/tuning.js';

export const tuningActions: ActionHandlers<
  'rescanTuning' | 'createSuggestion' | 'trackTip' | 'installPick' | 'openPickLink'
> = {
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
  installPick: async ({ rt }, action) => {
    const picks = tuningPicks(rt);
    const found = picks.pick(action.pickId);
    if (picks.busy) {
      return;
    }
    if (found === undefined) {
      picks.installing(null, { ok: false, text: 'That one is not in the list any more.' });
      return;
    }
    picks.installing(action.pickId, null);
    try {
      const text = await installEntry(rt, found.pick.kind, found.found);
      picks.installing(null, text === null ? null : { ok: true, text });
    } catch (error) {
      picks.installing(null, { ok: false, text: messageOf(error) });
    }
  },
  openPickLink: async ({ rt }, action) => {
    // Only a page the search found, so the webview cannot open any URL it likes.
    const url = tuningPicks(rt).pick(action.pickId)?.pick.url;
    if (url?.startsWith('https://') === true) {
      await rt.host.openExternal(url);
    }
  },
};
