// A HostPort that records every call and answers from queues the test fills.

import type { ViewId } from '../../../shared/protocol.js';
import { createMemorySecretStore } from '../../sync/secrets.js';
import type {
  FilePickRequest,
  HostPort,
  InputRequest,
  OverlordSettings,
  PanelParams,
  PickItem,
  TerminalRequest,
} from '../host-port.js';

const DEFAULT_SETTINGS: OverlordSettings = {
  activeWindowMinutes: 30,
  idleMinutes: 10,
  updateThrottleMs: 250,
  maxConcurrency: 4,
  holdTimeoutSeconds: 600,
  telemetryPort: 0,
  claudePath: 'claude',
  configRepoUrl: '',
  configRepoPath: '~/.claude-config',
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
  readonly terminals: TerminalRequest[] = [];
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly questions: { readonly message: string; readonly action: string }[] = [];
  readonly picks: { readonly items: readonly PickItem[]; readonly placeholder: string }[] = [];
  readonly inputs: InputRequest[] = [];
  readonly filePicks: FilePickRequest[] = [];
  readonly folderPicks: string[] = [];
  /** Answers, used in order. An empty queue answers no, null or cancel. */
  readonly confirmAnswers: boolean[] = [];
  readonly inputAnswers: (string | null)[] = [];
  readonly pickAnswers: (string | null)[] = [];
  readonly fileAnswers: (string | null)[] = [];
  readonly folderAnswers: (string | null)[] = [];
  readonly secrets = createMemorySecretStore();
  readonly storageDir: string;
  readonly extensionPath: string;
  settings: OverlordSettings;
  workspace: string | null;

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

  readonly runInTerminal = (request: TerminalRequest): void => {
    this.terminals.push(request);
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

  readonly showInfo = (message: string): void => {
    this.infos.push(message);
  };

  readonly showWarning = (message: string): void => {
    this.warnings.push(message);
  };

  readonly showError = (message: string): void => {
    this.errors.push(message);
  };

  readonly confirm = async (message: string, action: string): Promise<boolean> => {
    this.questions.push({ message, action });
    await Promise.resolve();
    return this.confirmAnswers.shift() ?? false;
  };

  readonly workspaceFolder = (): string | null => this.workspace;
}
