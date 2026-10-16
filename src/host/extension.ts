// VS Code entry point. Builds the app, the panels, the sidebar and the
// status bar, and maps every contributed command onto the app.

import * as vscode from 'vscode';

import { OverlordApp } from '../core/app/app.js';
import type { PanelParams } from '../core/app/host-port.js';
import { parseTransferUri } from '../core/app/transfer.js';
import type { HostToWebview, ViewId, WebviewAction } from '../shared/protocol.js';

import { CliTabs } from './cli-tabs.js';
import { createVscodeHostPort } from './host-port.js';
import { keepAwake } from './keep-awake.js';
import { PanelManager, SidebarView } from './panels.js';
import { reloadOnUpdate } from './self-update.js';

let app: OverlordApp | null = null;

type ViewEntry = readonly [command: string, view: ViewId, label: string, icon: string];

/** Settings and history that apply across every session. */
const GLOBAL_VIEWS: readonly ViewEntry[] = [
  ['overlord.openKnobs', 'knobs', 'Knobs', 'settings-gear'],
  ['overlord.openConfig', 'config', 'Config and Sync', 'repo'],
  ['overlord.openUsage', 'usage', 'Usage', 'graph'],
  ['overlord.openReputation', 'reputation', 'Reputation', 'robot'],
  ['overlord.openMessages', 'messages', 'Agent Messages', 'comment-discussion'],
  ['overlord.openTuning', 'tuning', 'Tuning', 'tools'],
  ['overlord.openHelp', 'help', 'Help', 'question'],
];

/** Views opened from buttons on the Fleet sidebar's title bar. */
const FLEET_TITLE_VIEWS: readonly ViewEntry[] = [
  ['overlord.openLauncher', 'launcher', 'Launcher', 'rocket'],
  ['overlord.openFleet', 'fleet', 'Fleet (full view)', 'pulse'],
  ['overlord.openSessions', 'sessions', 'All Sessions', 'list-unordered'],
];

/**
 * Views opened from the Command Palette only. The Context Inspector is about
 * one session, so the Fleet rows open it, and the palette opens it on a picker.
 */
const PALETTE_VIEWS: readonly ViewEntry[] = [
  ['overlord.openContext', 'context', 'Context Inspector', 'search'],
];

const VIEW_COMMANDS = [...GLOBAL_VIEWS, ...FLEET_TITLE_VIEWS, ...PALETTE_VIEWS];

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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The host port opens panels, and the panel manager needs the app, so the
  // port reaches the manager and the CLI tabs through holders once they exist.
  const panelHolder: { current: PanelManager | null } = { current: null };
  const propertiesHolder: { current: SidebarView | null } = { current: null };
  const tabsHolder: { current: CliTabs | null } = { current: null };
  const host = createVscodeHostPort({
    context,
    openPanel: (view, params) => {
      // Session properties live in the sidebar, beside the Fleet, not in a panel.
      const properties = propertiesHolder.current;
      if (view === 'properties' && properties !== null) {
        properties.setParams(params);
        properties.reveal();
        return;
      }
      panelHolder.current?.open(view, params);
    },
    onSessionTerminal: (terminal, sessionId) => {
      tabsHolder.current?.track(terminal, sessionId);
    },
    showSessionTerminal: (sessionId) => tabsHolder.current?.show(sessionId) ?? false,
  });
  const overlord = new OverlordApp({ host });
  app = overlord;
  const source = {
    stateFor: (view: ViewId, params: PanelParams): HostToWebview => overlord.stateFor(view, params),
    onChange: (listener: () => void): (() => void) => overlord.onChange(listener),
  };
  const onAction = async (action: WebviewAction, params: PanelParams): Promise<void> =>
    overlord.dispatch(action, params);
  const panels = new PanelManager(context.extensionUri, source, onAction);
  panelHolder.current = panels;
  const fleetSidebar = new SidebarView(
    { viewType: 'overlord.fleet', view: 'fleet' },
    context.extensionUri,
    source,
    onAction,
  );
  const propertiesSidebar = new SidebarView(
    { viewType: 'overlord.properties', view: 'properties' },
    context.extensionUri,
    source,
    onAction,
  );
  propertiesHolder.current = propertiesSidebar;
  // The fleet follows the focused tab, and a closed session tab lets go of its worktree.
  const tabs = new CliTabs(
    propertiesSidebar,
    (target) => {
      overlord.setActiveTerminal(target);
    },
    (sessionId) => {
      void overlord.sessionClosed(sessionId);
    },
    context.workspaceState,
  );
  // Pick up the Claude tabs Overlord opened before this reload, then say which is active.
  await tabs.restore();
  tabs.announceActive();
  tabsHolder.current = tabs;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'overlord.openFleet';
  status.tooltip = 'Overlord: open the fleet view';
  const update = (): void => {
    status.text = `$(pulse) ${overlord.statusLine()}`;
    status.show();
    // The app knows the focused terminal's session, including tabs Overlord did
    // not open once a process scan places them, so the properties view follows it.
    const sessionId = overlord.activeSession();
    propertiesSidebar.setParams(sessionId === null ? {} : { sessionId });
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
    keepAwake(),
    fleetSidebar,
    propertiesSidebar,
    ...[fleetSidebar, propertiesSidebar].map((sidebar) =>
      vscode.window.registerWebviewViewProvider(sidebar.viewType, sidebar, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    ),
    vscode.window.registerTreeDataProvider('overlord.global', new ViewListProvider(GLOBAL_VIEWS)),
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
    // Each new session gets its own worktree, so sessions never share files.
    // Starting it in the background takes a couple of seconds, so say so.
    register('overlord.newClaudeSession', async () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Starting Claude Code' },
        async () => dispatch({ type: 'newSession' }),
      ),
    ),
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
    // Turning sync on also sets up a new machine, so both commands do the same.
    register('overlord.connectConfigRepo', async () => dispatch({ type: 'turnOnSync' })),
    register('overlord.bootstrap', async () => dispatch({ type: 'turnOnSync' })),
    register('overlord.syncNow', async () => dispatch({ type: 'syncNow' })),
    register('overlord.syncPush', async () => overlord.sync.push()),
    register('overlord.syncPull', async () => overlord.sync.pull()),
    register('overlord.importDotfiles', async () => overlord.sync.importDotfiles()),
    register('overlord.refresh', async () => overlord.refresh()),
    // Each window runs its own Overlord, so the one coming to the front points
    // its Fleet at the session that belongs to it and pulls config changes.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        overlord.windowFocused();
      }
    }),
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
