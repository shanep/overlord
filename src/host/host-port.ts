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
} from '../core/app/host-port.js';
import { findOnPath } from '../core/find-on-path.js';
import { shellCommand } from '../core/shell-quote.js';
import type { ViewId } from '../shared/protocol.js';

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
    updateThrottleMs: config.get<number>('updateThrottleMs', 250),
    maxConcurrency: config.get<number>('maxConcurrency', 4),
    holdTimeoutSeconds: config.get<number>('permissions.holdTimeoutSeconds', 600),
    telemetryPort: config.get<number>('telemetry.port', 47_318),
    claudePath: resolveClaude(config.get<string>('claudePath', 'claude')),
    configRepoUrl: config.get<string>('configRepo.url', ''),
    configRepoPath: expandHome(config.get<string>('configRepo.path', '~/.claude-config')),
  };
}

export interface VscodeHostPortOptions {
  readonly context: vscode.ExtensionContext;
  readonly openPanel: (view: ViewId, params: PanelParams) => void;
}

export function createVscodeHostPort(options: VscodeHostPortOptions): HostPort {
  const { context } = options;
  return {
    openPanel: options.openPanel,
    openFile: async (file: string): Promise<void> => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document, { preview: false });
    },
    runInTerminal: (request: TerminalRequest): void => {
      const terminal = vscode.window.createTerminal({ name: request.name, cwd: request.cwd });
      terminal.show();
      terminal.sendText(shellCommand(request.command, request.args));
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
