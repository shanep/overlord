// Opens a Boise State chat: Claude Code in a tab of its own, talking to the
// boisestate.ai bridge sidecar this window runs. The backend has no tools, so
// the tab is a chat with Claude Code's screen, history and follow-ups, but it
// cannot edit files or run commands. It runs claude in the tab itself, not as
// a background session, since the sidecar goes away with the window.

import { randomUUID } from 'node:crypto';

import { bearerEnv, BRIDGE_BASE_URL, chatArgs } from '../bridge/boisestate.js';

import type { ActionHandlers } from './action-types.js';
import { messageOf } from './errors.js';
import type { Runtime } from './runtime.js';

async function openBridgeChat(rt: Runtime): Promise<void> {
  const resolve = rt.host.resolveBridgeEnv;
  if (resolve === undefined) {
    rt.host.showInfo('The Boise State bridge is not available in this window.');
    return;
  }
  let env: Record<string, string>;
  try {
    env = await resolve({ ANTHROPIC_BASE_URL: BRIDGE_BASE_URL });
  } catch (error: unknown) {
    rt.host.showWarning(messageOf(error));
    return;
  }
  const sessionId = randomUUID();
  rt.host.runInTerminal({
    name: 'Boise State Chat',
    command: rt.host.settings.claudePath,
    args: chatArgs(sessionId),
    cwd: rt.host.workspaceFolder() ?? rt.paths.home,
    sessionId,
    env: bearerEnv(env),
  });
}

export const bridgeActions: ActionHandlers<'newBridgeChat'> = {
  newBridgeChat: async ({ rt }) => {
    await openBridgeChat(rt);
  },
};
