import { describe, expect, it } from 'vitest';

import { isViewId, isWebviewToHost, VIEW_IDS } from './protocol.js';

describe('isWebviewToHost', () => {
  it('accepts a ready message for every known view', () => {
    for (const view of VIEW_IDS) {
      expect(isWebviewToHost({ type: 'ready', view })).toBe(true);
    }
  });

  it('rejects a ready message for an unknown or missing view', () => {
    expect(isWebviewToHost({ type: 'ready', view: 'nope' })).toBe(false);
    expect(isWebviewToHost({ type: 'ready', view: 3 })).toBe(false);
    expect(isWebviewToHost({ type: 'ready' })).toBe(false);
  });

  it('accepts an action message with a typed action', () => {
    expect(isWebviewToHost({ type: 'action', action: { type: 'stopAll' } })).toBe(true);
  });

  it('rejects malformed action messages', () => {
    expect(isWebviewToHost({ type: 'action', action: null })).toBe(false);
    expect(isWebviewToHost({ type: 'action' })).toBe(false);
    expect(isWebviewToHost({ type: 'action', action: { type: 1 } })).toBe(false);
  });

  it('rejects non objects and unknown types', () => {
    expect(isWebviewToHost({})).toBe(false);
    expect(isWebviewToHost(null)).toBe(false);
    expect(isWebviewToHost('ready')).toBe(false);
    expect(isWebviewToHost({ type: 'other' })).toBe(false);
    expect(isWebviewToHost({ type: 'other', action: { type: 'stopAll' } })).toBe(false);
  });
});

describe('isViewId', () => {
  it('accepts known view ids only', () => {
    expect(isViewId('fleet')).toBe(true);
    expect(isViewId('nope')).toBe(false);
    expect(isViewId(7)).toBe(false);
  });
});
