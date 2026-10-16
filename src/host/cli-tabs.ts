// Claude CLI tabs and the properties panel beside them. Each tab is tied to
// the session it runs, and the panel and the fleet follow whichever tab is
// active.

import * as vscode from 'vscode';

import type { ActiveTerminal } from '../core/app/places.js';

import type { PanelManager } from './panels.js';

/** True while the active terminal is a Claude CLI tab Overlord knows the session of. */
const ACTIVE_CONTEXT = 'overlord.cliTabActive';

const BESIDE = { beside: true, preserveFocus: true } as const;

export class CliTabs implements vscode.Disposable {
  private readonly sessions = new Map<vscode.Terminal, string>();
  private readonly subscriptions: readonly vscode.Disposable[];

  constructor(
    private readonly panels: PanelManager,
    /** Hears the session and shell pid of the active terminal, or null when none is active. */
    private readonly onActive: (terminal: ActiveTerminal | null) => void,
  ) {
    this.subscriptions = [
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        this.follow(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        this.sessions.delete(terminal);
        this.follow(vscode.window.activeTerminal);
      }),
    ];
  }

  /** Ties a new CLI tab to its session and opens the properties panel beside it. */
  track(terminal: vscode.Terminal, sessionId: string): void {
    this.sessions.set(terminal, sessionId);
    this.panels.open('properties', { sessionId }, BESIDE);
    this.setActiveContext(true);
    this.announceActive();
  }

  /** Tells the fleet which terminal is active now, for example right after activation. */
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

  /** Opens the properties panel for the active CLI tab, if there is one. */
  showActive(): void {
    const terminal = vscode.window.activeTerminal;
    const sessionId = terminal === undefined ? undefined : this.sessions.get(terminal);
    if (sessionId === undefined) {
      void vscode.window.showInformationMessage(
        'Overlord shows properties for Claude Code tabs it opened. Focus one and try again.',
      );
      return;
    }
    this.panels.open('properties', { sessionId }, BESIDE);
  }

  private async reportActive(terminal: vscode.Terminal | undefined): Promise<void> {
    if (terminal === undefined) {
      this.onActive(null);
      return;
    }
    const processId = (await terminal.processId) ?? null;
    this.onActive({ sessionId: this.sessions.get(terminal) ?? null, processId });
  }

  private follow(terminal: vscode.Terminal | undefined): void {
    void this.reportActive(terminal);
    const sessionId = terminal === undefined ? undefined : this.sessions.get(terminal);
    this.setActiveContext(sessionId !== undefined);
    if (sessionId !== undefined) {
      this.panels.pointTo('properties', { sessionId });
    }
  }

  private setActiveContext(active: boolean): void {
    void vscode.commands.executeCommand('setContext', ACTIVE_CONTEXT, active);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.sessions.clear();
  }
}
