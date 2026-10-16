// What the app needs from the editor. The vscode layer implements this, and
// tests pass a fake, so nothing under core/ ever imports vscode.

import type { ViewId } from '../../shared/protocol.js';
import type { SecretStore } from '../sync/secrets.js';

export interface PanelParams {
  readonly sessionId?: string;
  readonly agentId?: string;
}

export interface TerminalRequest {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface FilePickRequest {
  readonly title: string;
  /** Label to extensions without dots, as vscode's showOpenDialog takes them. */
  readonly filters: Readonly<Record<string, readonly string[]>>;
}

export interface InputRequest {
  readonly prompt: string;
  readonly value: string;
}

export interface PickItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** The overlord.* settings. The host should read them fresh on every access. */
export interface OverlordSettings {
  readonly activeWindowMinutes: number;
  readonly updateThrottleMs: number;
  readonly maxConcurrency: number;
  readonly holdTimeoutSeconds: number;
  readonly telemetryPort: number;
  readonly claudePath: string;
  readonly configRepoUrl: string;
  readonly configRepoPath: string;
}

export interface HostPort {
  readonly openPanel: (view: ViewId, params: PanelParams) => void;
  readonly openFile: (path: string) => Promise<void>;
  readonly runInTerminal: (request: TerminalRequest) => void;
  /** The picked file or folder path, or null when cancelled. */
  readonly pickFile: (request: FilePickRequest) => Promise<string | null>;
  readonly pickFolder: (title: string) => Promise<string | null>;
  /** The entered text, or null when cancelled. */
  readonly inputBox: (request: InputRequest) => Promise<string | null>;
  /** The id of the picked item, or null when cancelled. */
  readonly quickPick: (items: readonly PickItem[], placeholder: string) => Promise<string | null>;
  readonly showInfo: (message: string) => void;
  readonly showWarning: (message: string) => void;
  readonly showError: (message: string) => void;
  /** A modal question with one action button. True only when that button was pressed. */
  readonly confirm: (message: string, actionLabel: string) => Promise<boolean>;
  /** VS Code SecretStorage, which is the OS keychain. */
  readonly secrets: SecretStore;
  readonly workspaceFolder: () => string | null;
  /** The extension's global storage folder. */
  readonly storageDir: string;
  readonly extensionPath: string;
  readonly settings: OverlordSettings;
}
