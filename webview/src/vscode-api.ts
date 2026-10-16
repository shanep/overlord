// Typed wrapper over the VS Code webview API. Views talk to the host only
// through this interface, so tests can pass a fake.

import type { WebviewAction, WebviewToHost } from '../../src/shared/protocol.js';

export interface VsCodeApi {
  postMessage: (message: WebviewToHost) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

interface RawVsCodeApi {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

declare global {
  // Provided by VS Code inside a webview. It can be called only once.
  var acquireVsCodeApi: (() => RawVsCodeApi) | undefined;
}

/** An API that drops every message, for running the bundle outside VS Code. */
export function createDetachedApi(): VsCodeApi {
  let saved: unknown;
  return {
    postMessage: (): void => {
      // Nothing listens outside VS Code.
    },
    getState: (): unknown => saved,
    setState: (state): void => {
      saved = state;
    },
  };
}

/** Acquire the real API once, or a detached one when not inside a webview. */
export function createVsCodeApi(): VsCodeApi {
  const acquire = globalThis.acquireVsCodeApi;
  if (acquire === undefined) {
    return createDetachedApi();
  }
  const raw = acquire();
  return {
    postMessage: (message): void => {
      raw.postMessage(message);
    },
    getState: (): unknown => raw.getState(),
    setState: (state): void => {
      raw.setState(state);
    },
  };
}

/** Wrap a user action in the host message envelope. */
export function actionMessage(action: WebviewAction): WebviewToHost {
  return { type: 'action', action };
}
