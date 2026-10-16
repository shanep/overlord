// Claude CLI tabs. Each tab Overlord opens is tied to the session it runs, and
// the active terminal is reported to the app, which works out its session
// (a tab Overlord opened, a `claude attach` tab, or claude started by hand)
// for the fleet and the Session Properties view in the sidebar. A tab takes
// the name its session has in the fleet and follows it when it changes.

import * as vscode from 'vscode';

import type { ActiveTerminal } from '../core/app/places.js';
import { forgetTab, parseStoredTabs, rememberTab, restoreTabs } from '../core/tab-memory.js';

import type { SidebarView } from './panels.js';

/** True while the active terminal is a Claude CLI tab Overlord knows the session of. */
const ACTIVE_CONTEXT = 'overlord.cliTabActive';

/** Workspace state key for the tabs Overlord opened, so a reload does not forget them. */
const STORE_KEY = 'overlord.cliTabs';

/** VS Code has no API to rename a terminal, only this command, and it renames the active one. */
const RENAME_ACTIVE = 'workbench.action.terminal.renameWithArg';

/** What a tab tells the app, and what it asks of it. */
export interface CliTabHooks {
  /** Hears the session and shell pid of the active terminal, or null when none is active. */
  readonly onActive: (terminal: ActiveTerminal | null) => void;
  /** Hears the session of a tab Overlord opened once that tab closes. */
  readonly onClosed: (sessionId: string) => void;
  /** The session's name in the fleet, or null when the fleet does not list it. */
  readonly nameOf: (sessionId: string) => string | null;
}

export class CliTabs implements vscode.Disposable {
  private readonly sessions = new Map<vscode.Terminal, string>();
  /** The name each tab was last given, since a terminal's name may not follow a rename. */
  private readonly names = new Map<vscode.Terminal, string>();
  private readonly subscriptions: readonly vscode.Disposable[];

  constructor(
    private readonly properties: SidebarView,
    private readonly hooks: CliTabHooks,
    /** Where the tab list survives a window reload (the workspace state). */
    private readonly store: vscode.Memento,
  ) {
    this.subscriptions = [
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        this.follow(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        const sessionId = this.sessions.get(terminal);
        this.sessions.delete(terminal);
        this.names.delete(terminal);
        if (sessionId !== undefined) {
          this.hooks.onClosed(sessionId);
        }
        void this.forget(terminal);
        this.follow(vscode.window.activeTerminal);
      }),
    ];
  }

  /**
   * Picks the tabs Overlord opened back up after a reload. VS Code reconnects
   * a tab to the same running process, so its shell pid still matches.
   */
  async restore(): Promise<void> {
    const terminals = await Promise.all(
      vscode.window.terminals.map(async (terminal) => ({
        terminal,
        pid: await terminal.processId,
      })),
    );
    const open = terminals.flatMap(({ pid }) => (pid === undefined ? [] : [pid]));
    const { matched, kept } = restoreTabs(parseStoredTabs(this.store.get(STORE_KEY)), open);
    for (const { terminal, pid } of terminals) {
      const sessionId = pid === undefined ? undefined : matched.get(pid);
      if (sessionId !== undefined) {
        this.sessions.set(terminal, sessionId);
      }
    }
    await this.store.update(STORE_KEY, kept);
  }

  /** Ties a new CLI tab to its session and shows its properties in the sidebar. */
  track(terminal: vscode.Terminal, sessionId: string): void {
    this.sessions.set(terminal, sessionId);
    void this.remember(terminal, sessionId);
    this.setActiveContext(true);
    this.announceActive();
    this.syncName();
    this.properties.reveal();
  }

  private async remember(terminal: vscode.Terminal, sessionId: string): Promise<void> {
    const pid = await terminal.processId;
    if (pid !== undefined) {
      const stored = parseStoredTabs(this.store.get(STORE_KEY));
      await this.store.update(STORE_KEY, rememberTab(stored, pid, sessionId));
    }
  }

  private async forget(terminal: vscode.Terminal): Promise<void> {
    const pid = await terminal.processId;
    if (pid !== undefined) {
      const stored = parseStoredTabs(this.store.get(STORE_KEY));
      await this.store.update(STORE_KEY, forgetTab(stored, pid));
    }
  }

  /** Tells the app which terminal is active now, for example right after activation. */
  announceActive(): void {
    void this.reportActive(vscode.window.activeTerminal);
  }

  /** Focuses the newest tab Overlord opened for the session. False when none is open. */
  show(sessionId: string): boolean {
    let newest: vscode.Terminal | undefined;
    for (const [terminal, id] of this.sessions) {
      if (id === sessionId) {
        newest = terminal;
      }
    }
    newest?.show();
    return newest !== undefined;
  }

  /**
   * Renames the active tab to its session's name in the fleet. VS Code can
   * only rename the active terminal, so a tab in the background catches up
   * when it is next focused. Call whenever the fleet changes.
   */
  syncName(): void {
    const terminal = vscode.window.activeTerminal;
    const sessionId = terminal === undefined ? undefined : this.sessions.get(terminal);
    if (terminal === undefined || sessionId === undefined) {
      return;
    }
    const name = this.hooks.nameOf(sessionId);
    if (name === null || name === '' || name === (this.names.get(terminal) ?? terminal.name)) {
      return;
    }
    this.names.set(terminal, name);
    void vscode.commands.executeCommand(RENAME_ACTIVE, { name });
  }

  /** Opens the Session Properties view, which already follows the active Claude tab. */
  showActive(): void {
    this.announceActive();
    this.properties.reveal();
  }

  private async reportActive(terminal: vscode.Terminal | undefined): Promise<void> {
    if (terminal === undefined) {
      this.hooks.onActive(null);
      return;
    }
    const processId = (await terminal.processId) ?? null;
    this.hooks.onActive({ sessionId: this.sessions.get(terminal) ?? null, processId });
  }

  private follow(terminal: vscode.Terminal | undefined): void {
    void this.reportActive(terminal);
    this.setActiveContext(terminal !== undefined && this.sessions.has(terminal));
    this.syncName();
  }

  private setActiveContext(active: boolean): void {
    void vscode.commands.executeCommand('setContext', ACTIVE_CONTEXT, active);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.sessions.clear();
    this.names.clear();
  }
}
