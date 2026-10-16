// Actions for the agent messages view. Block rules go through the shared
// saveRule and deleteRule actions; this file only sets crossSessionInbound.

import { loadCatalog } from '../knobs/catalog.js';
import { writeSetting } from '../knobs/write.js';
import { INBOUND_KEY, inboundChoices } from '../messaging/inbound.js';

import type { ActionHandlers } from './action-types.js';
import { cachedMessages, refreshMessages } from './views/messages.js';

function question(value: string | null): string {
  return value === null
    ? `Remove ${INBOUND_KEY} from your user settings? Claude Code then decides per message.`
    : `Set ${INBOUND_KEY} to "${value}" in your user settings? New sessions pick it up.`;
}

export const messageActions: ActionHandlers<'setInboundPolicy'> = {
  setInboundPolicy: async ({ rt }, action) => {
    const { value } = action;
    const choices = inboundChoices(loadCatalog());
    if (value !== null && !choices.includes(value)) {
      rt.host.showError(
        `${value} is not a ${INBOUND_KEY} value. Use one of ${choices.join(', ')}.`,
      );
      return;
    }
    if (!(await rt.host.confirm(question(value), value === null ? 'Remove' : 'Save'))) {
      return;
    }
    const result = await writeSetting({
      file: rt.paths.userSettings,
      keyPath: INBOUND_KEY,
      value: value ?? undefined,
    });
    if (!result.ok) {
      rt.host.showError(result.error);
      return;
    }
    await refreshMessages(rt);
    const effective = cachedMessages(rt).inboundPolicy;
    if (effective !== value) {
      rt.host.showWarning(
        `Saved, but another settings file still decides: ${INBOUND_KEY} is ${effective ?? 'unset'}.`,
      );
    }
  },
};
