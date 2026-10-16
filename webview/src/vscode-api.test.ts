// cspell:ignore unstub
import { afterEach, describe, expect, it, vi } from 'vitest';

import { actionMessage, createDetachedApi, createVsCodeApi } from './vscode-api.js';

describe('createDetachedApi', () => {
  it('keeps state in memory and drops messages', () => {
    const api = createDetachedApi();
    expect(api.getState()).toBeUndefined();
    api.setState({ a: 1 });
    expect(api.getState()).toStrictEqual({ a: 1 });
    expect(() => {
      api.postMessage({ type: 'ready', view: 'fleet' });
    }).not.toThrow();
  });
});

describe('createVsCodeApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to a detached api outside VS Code', () => {
    const api = createVsCodeApi();
    api.setState('x');
    expect(api.getState()).toBe('x');
  });

  it('wraps the api VS Code provides', () => {
    const posted: unknown[] = [];
    let state: unknown = 'saved';
    let calls = 0;
    vi.stubGlobal('acquireVsCodeApi', () => {
      calls += 1;
      return {
        postMessage: (message: unknown): void => {
          posted.push(message);
        },
        getState: (): unknown => state,
        setState: (next: unknown): void => {
          state = next;
        },
      };
    });
    const api = createVsCodeApi();
    expect(calls).toBe(1);
    expect(api.getState()).toBe('saved');
    api.setState({ fleet: 1 });
    expect(state).toStrictEqual({ fleet: 1 });
    api.postMessage({ type: 'ready', view: 'usage' });
    expect(posted).toStrictEqual([{ type: 'ready', view: 'usage' }]);
  });
});

describe('actionMessage', () => {
  it('wraps an action in the envelope', () => {
    expect(actionMessage({ type: 'stopAll' })).toStrictEqual({
      type: 'action',
      action: { type: 'stopAll' },
    });
  });
});
