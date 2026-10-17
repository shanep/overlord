import { describe, expect, it } from 'vitest';

import { requests } from '../../test/fixtures.js';

import {
  cacheTable,
  contextTable,
  costTable,
  tokensTable,
  windowForRequests,
} from './agent-charts.js';

describe('windowForRequests', () => {
  it('reads the window from the model, or from a prompt too big for 200K', () => {
    expect(windowForRequests('claude-opus-4-6', requests)).toBe(200_000);
    expect(windowForRequests('claude-opus-4-7', [])).toBe(1_000_000);
    const big = requests.map((request) => ({
      ...request,
      usage: { ...request.usage, cacheRead: 300_000 },
    }));
    expect(windowForRequests('gateway-model', big)).toBe(1_000_000);
    expect(windowForRequests(null, [])).toBeNull();
  });

  it('knows no window for another agent', () => {
    expect(windowForRequests('claude-opus-4-7', [], 'codex')).toBeNull();
  });
});

describe('chart tables', () => {
  it('sorts requests by time and formats every column', () => {
    const reversed = requests.toReversed();
    const tokens = tokensTable(reversed);
    expect(tokens.columns).toStrictEqual(['Time', 'Input', 'Output', 'Cache read', 'Cache write']);
    expect(tokens.rows[0]?.slice(1)).toStrictEqual(['1.1K', '400', '25K', '2K']);
    expect(costTable(reversed).rows.map((row) => row[1])).toStrictEqual([
      '$0.05 est.',
      '$0.05 est.',
      'n/a',
      '$0.05 est.',
    ]);
    expect(contextTable(reversed).rows.map((row) => row[1])).toStrictEqual([
      '28.1K',
      '33.2K',
      '38.3K',
      '0',
    ]);
    expect(cacheTable(reversed).rows.map((row) => row[1])).toStrictEqual([
      '89%',
      '90%',
      '91%',
      'n/a',
    ]);
  });
});
