// Actions for the Connectors view: check again, sign in to a connector in a
// terminal, and open Chrome so the Claude extension can attach.

import type { Connector } from '../../shared/connectors.js';

import type { ActionHandlers } from './action-types.js';
import type { Runtime } from './runtime.js';
import { recheckConnectors } from './views/connectors.js';

/** The Claude extension takes a few seconds to attach after Chrome starts. */
export const CHROME_ATTACH_MS = 8000;

/** Starts Chrome on Linux without waiting for it, trying the usual binary names. */
const LINUX_OPEN_CHROME = [
  'for b in google-chrome google-chrome-stable chromium chromium-browser; do',
  'if command -v "$b" >/dev/null 2>&1; then nohup "$b" >/dev/null 2>&1 & exit 0; fi;',
  'done; exit 1',
].join(' ');

async function signIn(rt: Runtime, connector: Connector): Promise<void> {
  const cli = await rt.claudeCli();
  rt.host.runInTerminal({
    name: `Sign in: ${connector.name}`,
    command: cli.bin,
    args: ['mcp', 'login', connector.name],
    cwd: rt.host.workspaceFolder() ?? rt.paths.home,
    sessionId: null,
  });
  rt.host.showInfo(`Finish signing in to ${connector.name} in the terminal, then press Recheck.`);
}

async function openChrome(rt: Runtime): Promise<void> {
  const result =
    rt.platform === 'darwin'
      ? await rt.exec('open', ['-a', 'Google Chrome'], { timeoutMs: 15_000 })
      : await rt.exec('sh', ['-c', LINUX_OPEN_CHROME], { timeoutMs: 15_000 });
  if (result.code !== 0) {
    rt.host.showError('Could not find Chrome to open. Start it yourself, then press Recheck.');
    return;
  }
  await rt.delay(CHROME_ATTACH_MS);
  await recheckConnectors(rt);
}

export const connectorActions: ActionHandlers<'recheckConnectors' | 'fixConnector'> = {
  recheckConnectors: async ({ rt }) => {
    await recheckConnectors(rt);
  },
  fixConnector: async ({ rt }, action) => {
    const connector = rt.caches.connectors
      .peek()
      .connectors.find((entry) => entry.id === action.connectorId);
    if (connector?.fix === undefined || connector.fix === null) {
      rt.host.showError(`There is nothing Overlord can fix for ${action.connectorId}.`);
      return;
    }
    await (connector.fix === 'sign-in' ? signIn(rt, connector) : openChrome(rt));
  },
};
