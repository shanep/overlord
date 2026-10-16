// React context that hands the VS Code API to every view, plus hooks for
// posting actions and keeping small per-view UI state across reloads.

import type { ReactElement, ReactNode } from 'react';
import { createContext, useCallback, useContext, useState } from 'react';

import type { WebviewAction } from '../../src/shared/protocol.js';

import { isRecord } from './guards.js';
import type { VsCodeApi } from './vscode-api.js';
import { actionMessage, createDetachedApi } from './vscode-api.js';

const VsCodeContext = createContext<VsCodeApi>(createDetachedApi());

export function VsCodeProvider(props: {
  readonly api: VsCodeApi;
  readonly children: ReactNode;
}): ReactElement {
  return <VsCodeContext value={props.api}>{props.children}</VsCodeContext>;
}

export function useVsCode(): VsCodeApi {
  return useContext(VsCodeContext);
}

/** A stable function that posts a user action to the host. */
export function usePostAction(): (action: WebviewAction) => void {
  const api = useVsCode();
  return useCallback(
    (action: WebviewAction) => {
      api.postMessage(actionMessage(action));
    },
    [api],
  );
}

function readSaved<T>(
  api: VsCodeApi,
  key: string,
  guard: (value: unknown) => value is T,
): T | undefined {
  const saved = api.getState();
  if (!isRecord(saved)) {
    return undefined;
  }
  const value = saved[key];
  return guard(value) ? value : undefined;
}

/**
 * Like useState, but the value is saved with the webview state so it
 * survives the panel being hidden and shown. The guard checks saved data.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  guard: (value: unknown) => value is T,
): readonly [T, (next: T) => void] {
  const api = useVsCode();
  const [value, setValue] = useState<T>(() => readSaved(api, key, guard) ?? initial);
  const update = useCallback(
    (next: T) => {
      setValue(next);
      const saved = api.getState();
      api.setState({ ...(isRecord(saved) ? saved : {}), [key]: next });
    },
    [api, key],
  );
  return [value, update];
}
