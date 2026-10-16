// Claude CLI tabs. Each tab Overlord opens is tied to the session it runs, and
// the active terminal is reported to the app, which works out its session
// (a tab Overlord opened, a `claude attach` tab, or claude started by hand)
// for the fleet and the Session Properties view in the sidebar.

import * as vscode from 'vscode';

import type { ActiveTerminal } from '../core/app/places.js';

import type { SidebarView } from './panels.js';

/** True while the active terminal is a Claude CLI tab Overlord knows the session of. */
const ACTIVE_CONTEXT = 'overlord.cliTabActive';

export class CliTabs implements vscode.Disposable {
  private readonly sessions = new Map<vscode.Terminal, string>();
  private readonly subscriptions: readonly vscode.Disposable[];

  constructor(
    private readonly properties: SidebarView,
    /** Hears the session and shell pid of the active terminal, or null when none is active. */
    private readonly onActive: (terminal: ActiveTerminal | null) => void,
    /** Hears the session of a tab Overlord opened once that tab closes. */
    private readonly onClosed: (sessionId: string) => void,
  ) {
    this.subscriptions = [
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        this.follow(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        const sessionId = this.sessions.get(terminal);
        this.sessions.delete(terminal);
        if (sessionId !== undefined) {
          this.onClosed(sessionId);
        }
        this.follow(vscode.window.activeTerminal);
      }),
    ];
  }

  /** Ties a new CLI tab to its session and shows its properties in the sidebar. */
  track(terminal: vscode.Terminal, sessionId: string): void {
    this.sessions.set(terminal, sessionId);
    this.setActiveContext(true);
    this.announceActive();
    this.properties.reveal();
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

  /** Opens the Session Properties view, which already follows the active Claude tab. */
  showActive(): void {
    this.announceActive();
    this.properties.reveal();
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
    this.setActiveContext(terminal !== undefined && this.sessions.has(terminal));
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
