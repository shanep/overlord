// One webview panel per Overlord view. Panels get a full state push on ready
// and on every store change, and forward user actions to the action handler.

import { randomFillSync } from 'node:crypto';
import * as vscode from 'vscode';

import { buildWebviewHtml, makeNonce } from '../core/webview-html.js';
import type { HostToWebview, ViewId, WebviewAction } from '../shared/protocol.js';
import { isWebviewToHost } from '../shared/protocol.js';

export interface PanelParams {
  readonly sessionId?: string;
  readonly agentId?: string;
}

export interface StateSource {
  readonly stateFor: (view: ViewId, params: PanelParams) => HostToWebview;
  readonly onChange: (listener: () => void) => () => void;
}

export type ActionHandler = (action: WebviewAction, params: PanelParams) => Promise<void>;

const TITLES: Readonly<Record<ViewId, string>> = {
  fleet: 'Overlord: Fleet',
  agent: 'Overlord: Agent',
  context: 'Overlord: Context',
  knobs: 'Overlord: Knobs',
  launcher: 'Overlord: Launcher',
  sessions: 'Overlord: All Sessions',
  config: 'Overlord: Config and Sync',
  usage: 'Overlord: Usage',
  frustration: 'Overlord: Frustration',
  messages: 'Overlord: Agent Messages',
};

function isViewKey(value: string): value is ViewId {
  return Object.hasOwn(TITLES, value);
}

interface OpenPanel {
  readonly panel: vscode.WebviewPanel;
  params: PanelParams;
  ready: boolean;
}

export class PanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, OpenPanel>();
  private readonly offChange: () => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly source: StateSource,
    private readonly onAction: ActionHandler,
  ) {
    this.offChange = source.onChange(() => {
      this.pushAll();
    });
  }

  open(view: ViewId, params: PanelParams = {}): void {
    // The agent view keys on the agent so several can be open side by side.
    const key = view === 'agent' ? `agent:${params.sessionId ?? ''}:${params.agentId ?? ''}` : view;
    const existing = this.panels.get(key);
    if (existing !== undefined) {
      existing.params = params;
      existing.panel.reveal();
      this.push(view, existing);
      return;
    }
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel(
      `overlord.${view}`,
      TITLES[view],
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [webviewRoot] },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'overlord.svg');
    const entry: OpenPanel = { panel, params, ready: false };
    this.panels.set(key, entry);
    panel.webview.html = buildWebviewHtml({
      view,
      title: TITLES[view],
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js')).toString(),
      // The webview bundle injects its own stylesheet.
      styleUri: null,
      nonce: makeNonce((bytes) => randomFillSync(bytes)),
    });
    // @types/vscode declares onDidReceiveMessage as Event<any>. The handler
    // takes unknown and narrows with isWebviewToHost, so no any leaks out.
    // type-coverage:ignore-next-line
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isWebviewToHost(message)) {
        return;
      }
      if (message.type === 'ready') {
        entry.ready = true;
        this.push(view, entry);
        return;
      }
      await this.onAction(message.action, entry.params);
    });
    panel.onDidDispose(() => {
      this.panels.delete(key);
    });
  }

  private push(view: ViewId, entry: OpenPanel): void {
    if (!entry.ready) {
      return;
    }
    void entry.panel.webview.postMessage(this.source.stateFor(view, entry.params));
  }

  private pushAll(): void {
    for (const [key, entry] of this.panels) {
      const view = key.startsWith('agent:') ? 'agent' : key;
      if (isViewKey(view)) {
        this.push(view, entry);
      }
    }
  }

  dispose(): void {
    this.offChange();
    for (const entry of this.panels.values()) {
      entry.panel.dispose();
    }
    this.panels.clear();
  }
}

/** The Fleet docked in the Overlord sidebar, with the narrow layout. */
export class FleetSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'overlord.fleet';
  private view: vscode.WebviewView | null = null;
  private ready = false;
  private readonly offChange: () => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly source: StateSource,
    private readonly onAction: ActionHandler,
  ) {
    this.offChange = source.onChange(() => {
      this.push();
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    view.webview.html = buildWebviewHtml({
      view: 'fleet',
      title: TITLES.fleet,
      cspSource: view.webview.cspSource,
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js')).toString(),
      styleUri: null,
      nonce: makeNonce((bytes) => randomFillSync(bytes)),
      layout: 'sidebar',
    });
    // Same any-typed event as the panels, narrowed the same way.
    // type-coverage:ignore-next-line
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isWebviewToHost(message)) {
        return;
      }
      if (message.type === 'ready') {
        this.ready = true;
        this.push();
        return;
      }
      await this.onAction(message.action, {});
    });
    view.onDidDispose(() => {
      this.view = null;
      this.ready = false;
    });
  }

  private push(): void {
    if (this.view === null || !this.ready) {
      return;
    }
    void this.view.webview.postMessage(this.source.stateFor('fleet', {}));
  }

  dispose(): void {
    this.offChange();
  }
}
