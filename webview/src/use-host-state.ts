// Listens for host messages and keeps the latest state for one view.

import { useEffect, useState } from 'react';

import type { HostToWebview, ViewId } from '../../src/shared/protocol.js';

import { isHostToWebview } from './host-message.js';
import { useVsCode } from './vscode-context.js';

/** VS Code delivers host messages from the webview's own origin. */
export function isTrustedOrigin(origin: string): boolean {
  return origin === globalThis.location.origin || origin.startsWith('vscode-webview://');
}

/** The latest valid state message for `view`, or null until the host sends one. */
export function useHostState(view: ViewId): HostToWebview | null {
  const api = useVsCode();
  const [message, setMessage] = useState<HostToWebview | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      if (isTrustedOrigin(event.origin) && isHostToWebview(data) && data.view === view) {
        setMessage(data);
      }
    };
    globalThis.addEventListener('message', onMessage);
    api.postMessage({ type: 'ready', view });
    return (): void => {
      globalThis.removeEventListener('message', onMessage);
    };
  }, [api, view]);
  return message;
}
