// VS Code entry point. Builds the app, the panels, the sidebar and the
// status bar, and maps every contributed command onto the app.

import * as vscode from 'vscode';

import { OverlordApp } from '../core/app/app.js';
import type { RunningItem } from '../core/app/status.js';
import type { HostToWebview, ViewId, WebviewAction } from '../shared/protocol.js';

import { createVscodeHostPort } from './host-port.js';
import { PanelManager } from './panels.js';

let app: OverlordApp | null = null;

const VIEW_COMMANDS: readonly (readonly [string, ViewId, string])[] = [
  ['overlord.openFleet', 'fleet', 'Fleet'],
  ['overlord.openContext', 'context', 'Context Inspector'],
  ['overlord.openKnobs', 'knobs', 'Knobs'],
  ['overlord.openLauncher', 'launcher', 'Launcher'],
  ['overlord.openSessions', 'sessions', 'All Sessions'],
  ['overlord.openConfig', 'config', 'Config and Sync'],
  ['overlord.openUsage', 'usage', 'Usage'],
];

type ViewListEntry = readonly [string, ViewId | null, string];

const NEW_SESSION: ViewListEntry = ['overlord.newClaudeSession', null, 'New Claude Code session'];

class ViewListProvider implements vscode.TreeDataProvider<ViewListEntry> {
  getTreeItem(entry: ViewListEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry[2]);
    item.command = { command: entry[0], title: entry[2] };
    if (entry[1] === null) {
      item.iconPath = new vscode.ThemeIcon('sparkle');
    }
    return item;
  }

  getChildren(): ViewListEntry[] {
    return [NEW_SESSION, ...VIEW_COMMANDS];
  }
}

/** Starts an interactive Claude Code CLI in an editor tab, in the workspace folder. */
function newClaudeSession(claudePath: string, cwd: string | null): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: 'Claude Code',
    ...(cwd === null ? {} : { cwd }),
    location: { viewColumn: vscode.ViewColumn.Active },
    iconPath: new vscode.ThemeIcon('sparkle'),
    // Running claude as the terminal's process means closing the session closes the tab.
    shellPath: claudePath,
  });
  terminal.show();
  return terminal;
}

class RunningProvider implements vscode.TreeDataProvider<RunningItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: () => readonly RunningItem[]) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(entry: RunningItem): vscode.TreeItem {
    const collapsible =
      entry.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(entry.label, collapsible);
    item.id = entry.id;
    item.description = entry.description;
    item.tooltip = `${entry.label} (${entry.state})`;
    item.iconPath = new vscode.ThemeIcon(entry.state === 'waiting' ? 'bell' : 'pulse');
    item.command = {
      command: 'overlord.openAgent',
      title: 'Open agent',
      arguments: [entry.sessionId, entry.agentId],
    };
    return item;
  }

  getChildren(entry?: RunningItem): RunningItem[] {
    return [...(entry === undefined ? this.source() : entry.children)];
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The host port opens panels, and the panel manager needs the app, so the
  // port reaches the manager through this holder once it exists.
  const panelHolder: { current: PanelManager | null } = { current: null };
  const host = createVscodeHostPort({
    context,
    openPanel: (view, params) => {
      panelHolder.current?.open(view, params);
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

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'overlord.openFleet';
  status.tooltip = 'Overlord: open the fleet view';
  const running = new RunningProvider(() => overlord.runningItems());
  const update = (): void => {
    status.text = `$(pulse) ${overlord.statusLine()}`;
    status.show();
    running.refresh();
  };

  const dispatch = async (action: WebviewAction): Promise<void> => {
    await overlord.dispatch(action, {});
  };
  const register = (id: string, run: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, run);

  context.subscriptions.push(
    panels,
    status,
    running,
    vscode.window.registerTreeDataProvider('overlord.views', new ViewListProvider()),
    vscode.window.registerTreeDataProvider('overlord.sessions', running),
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
    register('overlord.setup', async () => {
      await overlord.setup.installHooks();
      await overlord.setup.enableTelemetry();
    }),
    register('overlord.installHooks', async (): Promise<void> => overlord.setup.installHooks()),
    register('overlord.uninstallHooks', async () => overlord.setup.uninstallHooks()),
    register('overlord.enableTelemetry', async () => overlord.setup.enableTelemetry()),
    register('overlord.disableTelemetry', async () => overlord.setup.disableTelemetry()),
    register('overlord.newClaudeSession', (): void => {
      newClaudeSession(host.settings.claudePath, host.workspaceFolder());
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
