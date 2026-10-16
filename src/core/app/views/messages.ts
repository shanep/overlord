// The agent messages view. Owned by the messaging work; this stub keeps the
// build green until that lands.

import type { MessagesState } from '../../../shared/protocol.js';
import type { Runtime } from '../runtime.js';

export const EMPTY_MESSAGES: MessagesState = {
  messages: [],
  routes: [],
  inboundPolicy: null,
  inboundChoices: [],
  rules: [],
};

export function buildMessages(_rt: Runtime): MessagesState {
  return EMPTY_MESSAGES;
}
