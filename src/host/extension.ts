// VS Code entry point. Builds the app, the panels, the sidebar and the
// status bar, and maps every contributed command onto the app.

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

import { OverlordApp } from '../core/app/app.js';
import { parseTransferUri } from '../core/app/transfer.js';
import type { HostToWebview, ViewId, WebviewAction } from '../shared/protocol.js';

import { CliTabs } from './cli-tabs.js';
import { createVscodeHostPort, terminalLaunch } from './host-port.js';
import { FleetSidebar, PanelManager } from './panels.js';
import { reloadOnUpdate } from './self-update.js';

let app: OverlordApp | null = null;

type ViewEntry = readonly [command: string, view: ViewId | null, label: string, icon: string];

/** Settings and history that apply across every session. */
const GLOBAL_VIEWS: readonly ViewEntry[] = [
  ['overlord.openKnobs', 'knobs', 'Knobs', 'settings-gear'],
  ['overlord.openConfig', 'config', 'Config and Sync', 'repo'],
  ['overlord.openUsage', 'usage', 'Usage', 'graph'],
  ['overlord.openFrustration', 'frustration', 'Frustration', 'flame'],
];

/** Views about particular sessions and agents. */
const SESSION_VIEWS: readonly ViewEntry[] = [
  ['overlord.newClaudeSession', null, 'New Claude Code session', 'sparkle'],
  ['overlord.openFleet', 'fleet', 'Fleet (full view)', 'pulse'],
  ['overlord.openSessions', 'sessions', 'All Sessions', 'list-unordered'],
  ['overlord.openLauncher', 'launcher', 'Launcher', 'rocket'],
  ['overlord.openContext', 'context', 'Context Inspector', 'search'],
  ['overlord.openMessages', 'messages', 'Agent Messages', 'comment-discussion'],
];

const VIEW_COMMANDS = [...GLOBAL_VIEWS, ...SESSION_VIEWS].flatMap(([command, view]) =>
  view === null ? [] : [[command, view] as const],
);

class ViewListProvider implements vscode.TreeDataProvider<ViewEntry> {
  constructor(private readonly entries: readonly ViewEntry[]) {}

  getTreeItem(entry: ViewEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry[2]);
    item.command = { command: entry[0], title: entry[2] };
    item.iconPath = new vscode.ThemeIcon(entry[3]);
    return item;
  }

  getChildren(): ViewEntry[] {
    return [...this.entries];
  }
}

/**
 * Starts an interactive Claude Code CLI in an editor tab, in the workspace
 * folder. Overlord picks the session id up front so the properties panel
 * knows which session the tab runs before Claude Code reports it.
 */
function newClaudeSession(claudePath: string, cwd: string | null, tabs: CliTabs): void {
  const sessionId = randomUUID();
  const terminal = vscode.window.createTerminal({
    name: 'Claude Code',
    ...(cwd === null ? {} : { cwd }),
    location: { viewColumn: vscode.ViewColumn.Active },
    iconPath: new vscode.ThemeIcon('sparkle'),
    // claude runs through the login shell (for the full PATH) and execs, so
    // closing the session closes the tab.
    ...terminalLaunch(claudePath, ['--session-id', sessionId]),
  });
  terminal.show();
  tabs.track(terminal, sessionId);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The host port opens panels, and the panel manager needs the app, so the
  // port reaches the manager and the CLI tabs through holders once they exist.
  const panelHolder: { current: PanelManager | null } = { current: null };
  const tabsHolder: { current: CliTabs | null } = { current: null };
  const host = createVscodeHostPort({
    context,
    openPanel: (view, params) => {
      panelHolder.current?.open(view, params);
    },
    onSessionTerminal: (terminal, sessionId) => {
      tabsHolder.current?.track(terminal, sessionId);
    },
  });
  const overlord = new OverlordApp({ host });
  app = overlord;
  const panels = new PanelManager(
    context.extensionUri,
    {
      stateFor: (view, params): HostToWebview => overlord.stateFor(view, params),
      onChange: (listener): (() => void) => overlord.onChange(listener),
    },
    async (action, params) => overlord.dispatch(action, params),
  );
  panelHolder.current = panels;
  const tabs = new CliTabs(panels);
  tabsHolder.current = tabs;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'overlord.openFleet';
  status.tooltip = 'Overlord: open the fleet view';
  const update = (): void => {
    status.text = `$(pulse) ${overlord.statusLine()}`;
    status.show();
  };

  const dispatch = async (action: WebviewAction): Promise<void> => {
    await overlord.dispatch(action, {});
  };
  const register = (id: string, run: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, run);

  context.subscriptions.push(
    panels,
    tabs,
    status,
    reloadOnUpdate(context, overlord.paths),
    vscode.window.registerWebviewViewProvider(
      FleetSidebar.viewType,
      new FleetSidebar(
        context.extensionUri,
        {
          stateFor: (view, params): HostToWebview => overlord.stateFor(view, params),
          onChange: (listener): (() => void) => overlord.onChange(listener),
        },
        async (action, params) => overlord.dispatch(action, params),
      ),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerTreeDataProvider('overlord.global', new ViewListProvider(GLOBAL_VIEWS)),
    vscode.window.registerTreeDataProvider(
      'overlord.sessionViews',
      new ViewListProvider(SESSION_VIEWS),
    ),
    ...VIEW_COMMANDS.map(([id, view]) =>
      register(id, (): void => {
        panels.open(view);
      }),
    ),
    register('overlord.openAgent', (sessionId: unknown, agentId: unknown): void => {
      if (typeof sessionId === 'string' && typeof agentId === 'string') {
        panels.open('agent', { sessionId, agentId });
      }
    }),
    register('overlord.setup', async (): Promise<void> => {
      await overlord.setup.installHooks();
      await overlord.setup.enableTelemetry();
      await overlord.installTransferSkill(vscode.env.uriScheme);
    }),
    register('overlord.installTransferSkill', async (): Promise<void> =>
      overlord.installTransferSkill(vscode.env.uriScheme),
    ),
    // vscode://shanep.overlord/continue?session=<id>, opened by the /overlord skill.
    vscode.window.registerUriHandler({
      handleUri: async (uri: vscode.Uri): Promise<void> => {
        const sessionId = parseTransferUri(uri.path, uri.query);
        if (sessionId === null) {
          void vscode.window.showWarningMessage(
            `Overlord does not know the link ${uri.toString()}.`,
          );
          return;
        }
        await overlord.continueSession(sessionId);
      },
    }),
    register('overlord.installHooks', async (): Promise<void> => overlord.setup.installHooks()),
    register('overlord.uninstallHooks', async () => overlord.setup.uninstallHooks()),
    register('overlord.enableTelemetry', async () => overlord.setup.enableTelemetry()),
    register('overlord.disableTelemetry', async () => overlord.setup.disableTelemetry()),
    register('overlord.newClaudeSession', (): void => {
      newClaudeSession(host.settings.claudePath, host.workspaceFolder(), tabs);
    }),
    register('overlord.showProperties', (): void => {
      tabs.showActive();
    }),
    register('overlord.launchPrompt', () => {
      panels.open('launcher');
    }),
    register('overlord.stopAll', async () => dispatch({ type: 'stopAll' })),
    register('overlord.newAgent', async () => dispatch({ type: 'newAgent' })),
    register('overlord.newSkill', async () => dispatch({ type: 'newSkill' })),
    register('overlord.importClaudeAi', async () => dispatch({ type: 'importClaudeAi' })),
    register('overlord.connectConfigRepo', async () => overlord.sync.connectConfigRepo()),
    register('overlord.syncPush', async () => overlord.sync.push()),
    register('overlord.syncPull', async () => overlord.sync.pull()),
    register('overlord.importDotfiles', async () => overlord.sync.importDotfiles()),
    register('overlord.bootstrap', async () => overlord.sync.bootstrap()),
    register('overlord.refresh', async () => overlord.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('overlord')) {
        overlord.applySettings();
      }
    }),
    { dispose: overlord.onChange(update) },
  );

  update();
  try {
    await overlord.start();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Overlord could not start: ${message}`);
  }
  update();
}

export async function deactivate(): Promise<void> {
  const current = app;
  app = null;
  await current?.dispose();
}
