// Actions for the Connectors view: check again, sign in to a connector in a
// terminal, open Chrome so the Claude extension can attach, and search the MCP
// registry and install a server from it into user scope.

import type { Connector } from '../../shared/connectors.js';
import { buildConfig, NAME_PATTERN } from '../connectors/install.js';

import type { ActionHandlers, ActionMap } from './action-types.js';
import { messageOf } from './errors.js';
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

const INSTALL_TIMEOUT_MS = 30_000;

/** Adds the server to user scope, so every session in every folder gets it. */
async function install(rt: Runtime, action: ActionMap['installConnector']): Promise<string> {
  const entry = rt.registry.entry(action.server);
  const option = entry?.server.options[action.option];
  const plan = entry?.plans[action.option];
  if (option === undefined || plan === undefined) {
    throw new Error(`${action.server} is not in the search results any more. Search again.`);
  }
  const name = action.name.trim();
  if (!NAME_PATTERN.test(name)) {
    throw new Error('A name can use only letters, digits, dashes and underscores.');
  }
  const built = buildConfig(plan, option.inputs, action.values);
  if (!built.ok) {
    throw new Error(built.error);
  }
  const cli = await rt.claudeCli();
  const result = await rt.exec(
    cli.bin,
    ['mcp', 'add-json', '--scope', 'user', name, JSON.stringify(built.config)],
    { cwd: rt.paths.home, env: cli.env, timeoutMs: INSTALL_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
    throw new Error(`claude mcp add-json failed: ${detail}`);
  }
  return name;
}

export const connectorActions: ActionHandlers<
  | 'recheckConnectors'
  | 'fixConnector'
  | 'searchRegistry'
  | 'moreRegistry'
  | 'openRegistryLink'
  | 'installConnector'
> = {
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
  searchRegistry: async ({ rt }, action) => {
    await rt.registry.search(action.query);
  },
  moreRegistry: async ({ rt }) => {
    await rt.registry.more();
  },
  openRegistryLink: async ({ rt }, action) => {
    // Only a repository the registry listed, so the webview cannot open any URL it likes.
    if (rt.registry.knowsLink(action.url) && /^https?:\/\//u.test(action.url)) {
      await rt.host.openExternal(action.url);
    }
  },
  installConnector: async ({ rt }, action) => {
    if (rt.registry.view().installing !== null) {
      return;
    }
    rt.registry.installing(action.server, null);
    let name: string;
    try {
      name = await install(rt, action);
    } catch (error) {
      rt.registry.installing(null, { ok: false, text: messageOf(error) });
      return;
    }
    rt.registry.installing(null, {
      ok: true,
      text: `Added ${name} for every project. New sessions get it. Checking it now.`,
    });
    await recheckConnectors(rt);
  },
};
