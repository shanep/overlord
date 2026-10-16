import { describe, expect, it } from 'vitest';

import { requests } from '../../test/fixtures.js';

import {
  cacheTable,
  contextTable,
  costTable,
  tokensTable,
  windowForModel,
} from './agent-charts.js';

describe('windowForModel', () => {
  it('knows the 1M window, the default window, and unknown models', () => {
    expect(windowForModel('claude-opus-4-7[1m]')).toBe(1_000_000);
    expect(windowForModel('claude-opus-4-7')).toBe(200_000);
    expect(windowForModel(null)).toBeNull();
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
