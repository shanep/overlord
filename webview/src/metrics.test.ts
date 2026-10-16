import { describe, expect, it } from 'vitest';

import { usage } from '../test/fixtures.js';

import { cacheHitRatio, callsPerMinute, promptTokens, totalTokens } from './metrics.js';

describe('metrics', () => {
  it('sums tokens', () => {
    const value = usage(100, 20, 300, 40);
    expect(totalTokens(value)).toBe(460);
    expect(promptTokens(value)).toBe(440);
  });

  it('computes cache hit ratio over prompt tokens', () => {
    expect(cacheHitRatio(usage(100, 20, 300, 100))).toBeCloseTo(0.6, 10);
    expect(cacheHitRatio(usage(0, 20))).toBeNull();
  });

  it('computes calls per minute and guards a zero span', () => {
    expect(callsPerMinute(30, 0, 120_000)).toBe(15);
    expect(callsPerMinute(5, 1000, 1000)).toBe(0);
    expect(callsPerMinute(5, 2000, 1000)).toBe(0);
  });
});
