import { describe, expect, it } from 'vitest';

import { chromeConnector, parseBrowsers } from './chrome.js';

const BASE = {
  id: 'chrome:claude-in-chrome',
  name: 'Claude in Chrome',
  kind: 'chrome',
  target: 'Chrome extension',
} as const;

describe('parseBrowsers', () => {
  it('names each browser and whether it is on this computer', () => {
    const text = JSON.stringify([
      { deviceId: 'd1', displayName: 'Work Mac', onThisComputer: true },
      { deviceId: 'd2', name: ' Laptop ', isLocal: true },
      { deviceId: 'd3' },
      { name: '' },
      'not a browser',
    ]);
    expect(parseBrowsers(text)).toStrictEqual([
      { name: 'Work Mac', here: true },
      { name: 'Laptop', here: true },
      { name: 'd3', here: false },
      { name: 'Chrome', here: false },
    ]);
  });

  it('throws when the answer is not a list', () => {
    expect(() => parseBrowsers('{}')).toThrow('list_connected_browsers did not answer with a list');
  });
});

describe('chromeConnector', () => {
  it('is ready when a browser is connected', () => {
    const text = JSON.stringify([
      { displayName: 'Work Mac', onThisComputer: true },
      { name: 'Lab' },
    ]);
    expect(chromeConnector({ answer: { text }, extensionInstalled: true })).toStrictEqual({
      ...BASE,
      status: 'ok',
      detail: 'Connected: Work Mac (this computer), Lab.',
      fix: null,
    });
  });

  it('offers to open Chrome when nothing is connected', () => {
    expect(chromeConnector({ answer: { text: '[]' }, extensionInstalled: null })).toStrictEqual({
      ...BASE,
      status: 'missing',
      detail:
        'No Chrome is connected. Open Chrome and check that the Claude extension is signed in to this account.',
      fix: 'open-chrome',
    });
  });

  it('says when the extension is not installed', () => {
    expect(chromeConnector({ answer: { text: '[]' }, extensionInstalled: false })).toStrictEqual({
      ...BASE,
      status: 'missing',
      detail:
        'The Claude in Chrome extension is not installed. Run /chrome in Claude Code to set it up.',
      fix: null,
    });
  });

  it('reports a probe that failed', () => {
    expect(
      chromeConnector({ answer: { error: 'timed out' }, extensionInstalled: true }),
    ).toStrictEqual({
      ...BASE,
      status: 'failed',
      detail: 'Could not ask Claude Code which browsers are connected: timed out',
      fix: null,
    });
  });

  it('reports an answer it cannot read', () => {
    expect(chromeConnector({ answer: { text: 'nope' }, extensionInstalled: true }).status).toBe(
      'unknown',
    );
    expect(chromeConnector({ answer: { text: '{}' }, extensionInstalled: true }).detail).toBe(
      'list_connected_browsers did not answer with a list',
    );
  });
});
