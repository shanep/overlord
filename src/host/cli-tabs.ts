// Claude CLI tabs and the properties panel beside them. Each tab is tied to
// the session it runs, and the panel follows whichever tab is active.

import * as vscode from 'vscode';

import type { PanelManager } from './panels.js';

/** True while the active terminal is a Claude CLI tab Overlord knows the session of. */
const ACTIVE_CONTEXT = 'overlord.cliTabActive';

const BESIDE = { beside: true, preserveFocus: true } as const;

export class CliTabs implements vscode.Disposable {
  private readonly sessions = new Map<vscode.Terminal, string>();
  private readonly subscriptions: readonly vscode.Disposable[];

  constructor(private readonly panels: PanelManager) {
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

  private follow(terminal: vscode.Terminal | undefined): void {
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
