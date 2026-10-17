// A HostPort that records every call and answers from queues the test fills.

import type { ViewId } from '../../../shared/protocol.js';
import { NO_CUSTOM_AGENTS } from '../../agents/custom.js';
import type { EndpointSource } from '../../bridge/backend.js';
import { createMemorySecretStore } from '../../sync/secrets.js';
import type {
  FilePickRequest,
  GitHubSession,
  HostPort,
  InputRequest,
  OverlordSettings,
  PanelParams,
  PickItem,
  TerminalRequest,
  TerminalTarget,
} from '../host-port.js';

const DEFAULT_SETTINGS: OverlordSettings = {
  activeWindowMinutes: 30,
  idleMinutes: 10,
  updateThrottleMs: 250,
  maxConcurrency: 4,
  paceToUsageLimit: true,
  holdTimeoutSeconds: 600,
  coordinateSessions: true,
  launchCheck: false,
  telemetryPort: 0,
  claudePath: 'claude',
  agents: {},
  customAgents: NO_CUSTOM_AGENTS,
  configRepoUrl: '',
  configRepoPath: '~/.overlord-config',
  configSyncAuto: true,
  configSyncIntervalMinutes: 5,
  briefSessions: true,
  leaderboardEnabled: false,
  leaderboardUrl: '',
};

export interface FakeHostOptions {
  readonly storageDir: string;
  readonly extensionPath?: string;
  readonly workspace?: string | null;
  readonly settings?: Partial<OverlordSettings>;
}

export class FakeHost implements HostPort {
  readonly panels: { readonly view: ViewId; readonly params: PanelParams }[] = [];
  readonly opened: string[] = [];
  readonly external: string[] = [];
  readonly folders: string[] = [];
  readonly windows: string[] = [];
  readonly progress: string[] = [];
  readonly terminals: TerminalRequest[] = [];
  /** The backends' endpoints, when a test gives the host some. */
  backendEndpoint?: EndpointSource;
  readonly shown: TerminalTarget[] = [];
  /** Session ids with a tab Overlord opened, which showTerminal finds. */
  terminalTabs: readonly string[] = [];
  /** What terminalPids reports. */
  shellPids: readonly number[] = [];
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly questions: { readonly message: string; readonly action: string }[] = [];
  readonly asks: { readonly message: string; readonly actions: readonly string[] }[] = [];
  readonly picks: { readonly items: readonly PickItem[]; readonly placeholder: string }[] = [];
  readonly inputs: InputRequest[] = [];
  readonly filePicks: FilePickRequest[] = [];
  readonly folderPicks: string[] = [];
  /** Answers, used in order. An empty queue answers no, null or cancel. */
  readonly confirmAnswers: boolean[] = [];
  readonly askAnswers: (string | null)[] = [];
  readonly inputAnswers: (string | null)[] = [];
  readonly pickAnswers: (string | null)[] = [];
  readonly pickManyAnswers: (readonly string[] | null)[] = [];
  readonly fileAnswers: (string | null)[] = [];
  readonly folderAnswers: (string | null)[] = [];
  /** What gitHubSession returns. Null is signed out, and an interactive call then gets the queue. */
  gitHubSignedIn: GitHubSession | null = null;
  /** Sessions an interactive sign in hands out, in order. Empty means the user cancelled. */
  readonly gitHubSignIns: GitHubSession[] = [];
  readonly gitHubRequests: boolean[] = [];
  readonly savedSettings: { readonly key: string; readonly value: string }[] = [];
  readonly secrets = createMemorySecretStore();
  readonly storageDir: string;
  readonly extensionPath: string;
  settings: OverlordSettings;
  workspace: string | null;
  /** Workspace folders after the first, which is workspace. */
  moreFolders: readonly string[] = [];

  constructor(options: FakeHostOptions) {
    this.storageDir = options.storageDir;
    this.extensionPath = options.extensionPath ?? '/ext';
    this.workspace = options.workspace ?? null;
    this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
  }

  readonly openPanel = (view: ViewId, params: PanelParams): void => {
    this.panels.push({ view, params });
  };

  readonly openFile = async (file: string): Promise<void> => {
    this.opened.push(file);
    await Promise.resolve();
  };

  readonly openExternal = async (url: string): Promise<void> => {
    this.external.push(url);
    await Promise.resolve();
  };

  readonly showFolder = async (folder: string): Promise<void> => {
    this.folders.push(folder);
    await Promise.resolve();
  };

  readonly openWindow = async (folder: string): Promise<void> => {
    this.windows.push(folder);
    await Promise.resolve();
  };

  readonly withProgress = async <T>(title: string, task: () => Promise<T>): Promise<T> => {
    this.progress.push(title);
    return task();
  };

  readonly runInTerminal = (request: TerminalRequest): void => {
    this.terminals.push(request);
  };

  readonly showTerminal = async (target: TerminalTarget): Promise<boolean> => {
    this.shown.push(target);
    await Promise.resolve();
    return (
      this.terminalTabs.includes(target.sessionId) ||
      (target.processId !== null && this.shellPids.includes(target.processId))
    );
  };

  readonly terminalPids = async (): Promise<readonly number[]> => {
    await Promise.resolve();
    return this.shellPids;
  };

  readonly pickFile = async (request: FilePickRequest): Promise<string | null> => {
    this.filePicks.push(request);
    await Promise.resolve();
    return this.fileAnswers.shift() ?? null;
  };

  readonly pickFolder = async (title: string): Promise<string | null> => {
    this.folderPicks.push(title);
    await Promise.resolve();
    return this.folderAnswers.shift() ?? null;
  };

  readonly inputBox = async (request: InputRequest): Promise<string | null> => {
    this.inputs.push(request);
    await Promise.resolve();
    return this.inputAnswers.shift() ?? null;
  };

  readonly quickPick = async (
    items: readonly PickItem[],
    placeholder: string,
  ): Promise<string | null> => {
    this.picks.push({ items, placeholder });
    await Promise.resolve();
    return this.pickAnswers.shift() ?? null;
  };

  readonly quickPickMany = async (
    items: readonly PickItem[],
    placeholder: string,
  ): Promise<readonly string[] | null> => {
    this.picks.push({ items, placeholder });
    await Promise.resolve();
    return this.pickManyAnswers.shift() ?? null;
  };

  readonly showInfo = (message: string): void => {
    this.infos.push(message);
  };

  readonly showWarning = (message: string): void => {
    this.warnings.push(message);
  };

  readonly showError = (message: string): void => {
    this.errors.push(message);
  };

  readonly ask = async (message: string, actions: readonly string[]): Promise<string | null> => {
    this.asks.push({ message, actions });
    await Promise.resolve();
    return this.askAnswers.shift() ?? null;
  };

  readonly confirm = async (message: string, action: string): Promise<boolean> => {
    this.questions.push({ message, action });
    await Promise.resolve();
    return this.confirmAnswers.shift() ?? false;
  };

  readonly gitHubSession = async (interactive: boolean): Promise<GitHubSession | null> => {
    this.gitHubRequests.push(interactive);
    await Promise.resolve();
    if (this.gitHubSignedIn === null && interactive) {
      this.gitHubSignedIn = this.gitHubSignIns.shift() ?? null;
    }
    return this.gitHubSignedIn;
  };

  readonly saveSetting = async (key: string, value: string): Promise<void> => {
    this.savedSettings.push({ key, value });
    await Promise.resolve();
    if (key === 'configRepo.url') {
      this.settings = { ...this.settings, configRepoUrl: value };
    }
  };

  readonly workspaceFolder = (): string | null => this.workspace;

  readonly workspaceFolders = (): readonly string[] => [
    ...(this.workspace === null ? [] : [this.workspace]),
    ...this.moreFolders,
  ];
}
