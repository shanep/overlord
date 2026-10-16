// Routes every webview action to its handler. Actions arrive over
// postMessage, so a malformed one is possible; it gets a plain message, and
// no handler failure ever escapes as an exception.

import type { WebviewAction } from '../../shared/protocol.js';

import type { ActionContext, ActionHandlers, ActionMap, ActionType } from './action-types.js';
import { authoringActions } from './actions-authoring.js';
import { configActions } from './actions-config.js';
import { frustrationActions } from './actions-frustration.js';
import { launchActions } from './actions-launch.js';
import { messageActions } from './actions-messages.js';
import { sessionActions } from './actions-session.js';
import { messageOf } from './errors.js';
import type { PanelParams } from './host-port.js';
import type { Runtime } from './runtime.js';

const HANDLERS: ActionHandlers<ActionType> = {
  ...sessionActions,
  ...launchActions,
  ...configActions,
  ...authoringActions,
  ...frustrationActions,
  ...messageActions,
};

function isActionType(value: string): value is ActionType {
  return Object.hasOwn(HANDLERS, value);
}

async function run<K extends ActionType>(
  type: K,
  action: ActionMap[K],
  context: ActionContext,
): Promise<void> {
  const handler: ActionHandlers<ActionType>[K] = HANDLERS[type];
  await handler(context, action);
}

export async function dispatch(
  rt: Runtime,
  action: WebviewAction,
  params: PanelParams,
): Promise<void> {
  const type: string = action.type;
  if (!isActionType(type)) {
    rt.host.showInfo(`Overlord does not know the action "${type}".`);
    return;
  }
  try {
    await run(action.type, action, { rt, params });
  } catch (error) {
    rt.host.showError(messageOf(error));
  }
}
