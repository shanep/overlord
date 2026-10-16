// The vscode side of the app's HostPort. Everything editor-specific lives here.

import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

import type {
  FilePickRequest,
  HostPort,
  InputRequest,
  OverlordSettings,
  PanelParams,
  PickItem,
  TerminalRequest,
  TerminalTarget,
} from '../core/app/host-port.js';
import { findOnPath } from '../core/find-on-path.js';
import { loginShellLaunch } from '../core/login-shell.js';
import type { ViewId } from '../shared/protocol.js';

/** claude through the login shell, so the tab gets the user's full PATH. */
function terminalLaunch(
  command: string,
  args: readonly string[],
): { shellPath: string; shellArgs: string[] } {
  const launch = loginShellLaunch({
    command,
    args,
    shell: process.env['SHELL'],
    platform: process.platform,
  });
  return { shellPath: launch.shellPath, shellArgs: [...launch.shellArgs] };
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;
}

// The packaged extension does not ship the SDK's bundled CLI, so a bare
// "claude" is resolved to the user's installed binary on PATH.
function resolveClaude(value: string): string {
  const name = value.trim() === '' ? 'claude' : value.trim();
  return findOnPath({ name, pathValue: process.env['PATH'], platform: process.platform }) ?? name;
}

function readSettings(): OverlordSettings {
  const config = vscode.workspace.getConfiguration('overlord');
  return {
    activeWindowMinutes: config.get<number>('activeWindowMinutes', 30),
    idleMinutes: config.get<number>('idleMinutes', 10),
    updateThrottleMs: config.get<number>('updateThrottleMs', 250),
    maxConcurrency: config.get<number>('maxConcurrency', 4),
    holdTimeoutSeconds: config.get<number>('permissions.holdTimeoutSeconds', 600),
    telemetryPort: config.get<number>('telemetry.port', 47_318),
    claudePath: resolveClaude(config.get<string>('claudePath', 'claude')),
    configRepoUrl: config.get<string>('configRepo.url', ''),
    configRepoPath: expandHome(config.get<string>('configRepo.path', '~/.claude-config')),
  };
}

/** How long to wait for VS Code to report a folder added to the workspace. */
const FOLDER_ADDED_MS = 5000;

/** Resolves once the workspace folders change, or after FOLDER_ADDED_MS, whichever comes first. */
async function foldersChanged(): Promise<void> {
  let listener: vscode.Disposable | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve) => {
      listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        resolve();
      });
      timer = setTimeout(resolve, FOLDER_ADDED_MS);
    });
  } finally {
    clearTimeout(timer);
    listener?.dispose();
  }
}

/**
 * Append the folder to the workspace, so the window's first folder stays put.
 * Changing the first folder restarts every extension, Overlord included.
 */
async function addToWorkspace(uri: vscode.Uri): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.some((item) => item.uri.fsPath === uri.fsPath)) {
    return;
  }
  const changed = foldersChanged();
  if (!vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri })) {
    throw new Error(`VS Code would not add ${uri.fsPath} to this window.`);
  }
  await changed;
}

export interface VscodeHostPortOptions {
  readonly context: vscode.ExtensionContext;
  readonly openPanel: (view: ViewId, params: PanelParams) => void;
  /** Called with each terminal that runs a known Claude Code session. */
  readonly onSessionTerminal: (terminal: vscode.Terminal, sessionId: string) => void;
  /** Focuses the tab Overlord opened for a session. False when there is none. */
  readonly showSessionTerminal: (sessionId: string) => boolean;
}

async function terminalWithProcess(processId: number): Promise<vscode.Terminal | undefined> {
  const pids = await Promise.all(vscode.window.terminals.map(async (item) => item.processId));
  return vscode.window.terminals[pids.indexOf(processId)];
}

export function createVscodeHostPort(options: VscodeHostPortOptions): HostPort {
  const { context } = options;
  return {
    openPanel: options.openPanel,
    openFile: async (file: string): Promise<void> => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document, { preview: false });
    },
    showFolder: async (folder: string): Promise<void> => {
      const uri = vscode.Uri.file(folder);
      await addToWorkspace(uri);
      await vscode.commands.executeCommand('workbench.view.explorer');
      await vscode.commands.executeCommand('revealInExplorer', uri);
    },
    runInTerminal: (request: TerminalRequest): void => {
      // Claude sessions get a full editor tab, like the CLI in its own window.
      const terminal = vscode.window.createTerminal({
        name: request.name,
        cwd: request.cwd,
        ...(request.env === undefined ? {} : { env: { ...request.env } }),
        location: { viewColumn: vscode.ViewColumn.Active },
        iconPath: new vscode.ThemeIcon('sparkle'),
        // Run claude as the terminal's own process: no shell quoting, and the
        // tab closes when the session ends.
        ...terminalLaunch(request.command, request.args),
      });
      terminal.show();
      if (request.sessionId !== null) {
        options.onSessionTerminal(terminal, request.sessionId);
      }
    },
    showTerminal: async (target: TerminalTarget): Promise<boolean> => {
      if (options.showSessionTerminal(target.sessionId)) {
        return true;
      }
      const terminal =
        target.processId === null ? undefined : await terminalWithProcess(target.processId);
      terminal?.show();
      return terminal !== undefined;
    },
    terminalPids: async (): Promise<readonly number[]> => {
      const pids = await Promise.all(vscode.window.terminals.map(async (item) => item.processId));
      return pids.filter((pid) => pid !== undefined);
    },
    pickFile: async (request: FilePickRequest): Promise<string | null> => {
      const filters: Record<string, string[]> = {};
      for (const [label, extensions] of Object.entries(request.filters)) {
        filters[label] = [...extensions];
      }
      const picked = await vscode.window.showOpenDialog({
        title: request.title,
        canSelectMany: false,
        canSelectFolders: false,
        filters,
      });
      return picked?.[0]?.fsPath ?? null;
    },
    pickFolder: async (title: string): Promise<string | null> => {
      const picked = await vscode.window.showOpenDialog({
        title,
        canSelectMany: false,
        canSelectFiles: false,
        canSelectFolders: true,
      });
      return picked?.[0]?.fsPath ?? null;
    },
    inputBox: async (request: InputRequest): Promise<string | null> =>
      (await vscode.window.showInputBox({ prompt: request.prompt, value: request.value })) ?? null,
    quickPick: async (items: readonly PickItem[], placeholder: string): Promise<string | null> => {
      const picked = await vscode.window.showQuickPick(
        items.map((item) => ({ label: item.label, description: item.description, id: item.id })),
        { placeHolder: placeholder },
      );
      return picked?.id ?? null;
    },
    showInfo: (message: string): void => {
      void vscode.window.showInformationMessage(message);
    },
    showWarning: (message: string): void => {
      void vscode.window.showWarningMessage(message);
    },
    showError: (message: string): void => {
      void vscode.window.showErrorMessage(message);
    },
    ask: async (message: string, actions: readonly string[]): Promise<string | null> =>
      (await vscode.window.showWarningMessage(message, ...actions)) ?? null,
    confirm: async (message: string, actionLabel: string): Promise<boolean> =>
      (await vscode.window.showWarningMessage(message, { modal: true }, actionLabel)) ===
      actionLabel,
    secrets: {
      get: async (name: string): Promise<string | undefined> => context.secrets.get(name),
      set: async (name: string, value: string): Promise<void> => {
        await context.secrets.store(name, value);
      },
      delete: async (name: string): Promise<void> => {
        await context.secrets.delete(name);
      },
    },
    workspaceFolder: (): string | null =>
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    storageDir: context.globalStorageUri.fsPath,
    extensionPath: context.extensionUri.fsPath,
    get settings(): OverlordSettings {
      return readSettings();
    },
  };
}
