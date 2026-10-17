// What the app needs from the editor. The vscode layer implements this, and
// tests pass a fake, so nothing under core/ ever imports vscode.

import type { ViewId } from '../../shared/protocol.js';
import type { SecretStore } from '../sync/secrets.js';

export interface PanelParams {
  readonly sessionId?: string;
  readonly agentId?: string;
}

export interface TerminalTarget {
  readonly sessionId: string;
  readonly processId: number | null;
}

export interface TerminalRequest {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The Claude Code session the terminal runs, when known, for the properties panel. */
  readonly sessionId: string | null;
  /** Variables layered over the terminal's environment, such as a worktree's port slot. */
  readonly env?: Readonly<Record<string, string>>;
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
  readonly idleMinutes: number;
  readonly updateThrottleMs: number;
  readonly maxConcurrency: number;
  readonly holdTimeoutSeconds: number;
  /** Tell sessions in one repository about each other and pause clashing edits. */
  readonly coordinateSessions: boolean;
  readonly telemetryPort: number;
  readonly claudePath: string;
  readonly configRepoUrl: string;
  readonly configRepoPath: string;
  /** Commit, pull and push the config repo in the background once it is connected. */
  readonly configSyncAuto: boolean;
  /** How often the background sync checks the remote. */
  readonly configSyncIntervalMinutes: number;
  /** Tell each new session which connectors work and to check the ones it needs first. */
  readonly briefSessions: boolean;
  /** Tell each new session in an Overlord worktree what its repository's setup means for it. */
  readonly launchCheck: boolean;
  /** Show the global Reputation leaderboard. Off means the leaderboard server is never called. */
  readonly leaderboardEnabled: boolean;
  /** The leaderboard server, or empty when there is none. */
  readonly leaderboardUrl: string;
}

/** A GitHub sign-in from the editor's own account list. */
export interface GitHubSession {
  readonly accessToken: string;
  readonly account: string;
}

export interface HostPort {
  readonly openPanel: (view: ViewId, params: PanelParams) => void;
  readonly openFile: (path: string) => Promise<void>;
  /** Open a web page in the default browser. */
  readonly openExternal: (url: string) => Promise<void>;
  /**
   * Add a folder to this window's workspace, unless it is there already, and
   * show it in the Explorer. The window stays open, so its terminals keep running.
   */
  readonly showFolder: (folder: string) => Promise<void>;
  /** Open a folder in a new window, or bring forward the window that has it open. */
  readonly openWindow: (folder: string) => Promise<void>;
  /** Run a task under a notification that says what is happening until it settles. */
  readonly withProgress: <T>(title: string, task: () => Promise<T>) => Promise<T>;
  readonly runInTerminal: (request: TerminalRequest) => void;
  /**
   * Focus the terminal tab for a session: the tab Overlord opened for it, or
   * else the terminal whose shell has processId. False when there is none.
   */
  readonly showTerminal: (target: TerminalTarget) => Promise<boolean>;
  /** Process ids of the shells behind this window's open terminals. */
  readonly terminalPids: () => Promise<readonly number[]>;
  /** The picked file or folder path, or null when cancelled. */
  readonly pickFile: (request: FilePickRequest) => Promise<string | null>;
  readonly pickFolder: (title: string) => Promise<string | null>;
  /** The entered text, or null when cancelled. */
  readonly inputBox: (request: InputRequest) => Promise<string | null>;
  /** The id of the picked item, or null when cancelled. */
  readonly quickPick: (items: readonly PickItem[], placeholder: string) => Promise<string | null>;
  /** The ids of the checked items, or null when cancelled. */
  readonly quickPickMany: (
    items: readonly PickItem[],
    placeholder: string,
  ) => Promise<readonly string[] | null>;
  readonly showInfo: (message: string) => void;
  readonly showWarning: (message: string) => void;
  readonly showError: (message: string) => void;
  /** A notification with buttons. The label of the pressed one, or null when it is dismissed. */
  readonly ask: (message: string, actions: readonly string[]) => Promise<string | null>;
  /** A modal question with one action button. True only when that button was pressed. */
  readonly confirm: (message: string, actionLabel: string) => Promise<boolean>;
  /**
   * The editor's GitHub sign-in, the same one its GitHub and pull request
   * support use. Interactive asks the user to sign in when there is none;
   * otherwise null means not signed in or cancelled.
   */
  readonly gitHubSession: (
    interactive: boolean,
    /** Defaults to the scopes git needs. Pass fewer when only the account is needed. */
    scopes?: readonly string[],
  ) => Promise<GitHubSession | null>;
  /** Save an overlord.* setting for the user, across every workspace. */
  readonly saveSetting: (key: string, value: string) => Promise<void>;
  /** VS Code SecretStorage, which is the OS keychain. */
  readonly secrets: SecretStore;
  /**
   * Rewrite a launch env that opts into the boisestate.ai bridge, starting the
   * sidecar if needed and pointing the env at it. Returns the env unchanged when
   * it does not opt in. Absent when the host does not provide a bridge.
   */
  readonly resolveBridgeEnv?: (
    env: Readonly<Record<string, string>>,
  ) => Promise<Record<string, string>>;
  readonly workspaceFolder: () => string | null;
  /** Every folder in this window's workspace, the first one first. */
  readonly workspaceFolders: () => readonly string[];
  /** The extension's global storage folder. */
  readonly storageDir: string;
  readonly extensionPath: string;
  readonly settings: OverlordSettings;
}
