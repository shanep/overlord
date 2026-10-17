import { describe, expect, it } from 'vitest';

import type { DailyUsage } from '../../shared/model.js';

import { averageTokensPerDay } from './tokens.js';

const NOW = new Date(2026, 9, 16, 9).getTime();

function day(date: string, tokensByModel: Record<string, number>): DailyUsage {
  return { date, messages: 1, sessions: 1, toolCalls: 0, tokensByModel };
}

describe('averageTokensPerDay', () => {
  it('is 0 with no history', () => {
    expect(averageTokensPerDay([], NOW)).toBe(0);
  });

  it('averages every model over the 60 days ending today', () => {
    const days = [
      day('2026-01-01', { opus: 9_000_000 }),
      day('2026-08-17', { opus: 1_000_000 }),
      day('2026-08-18', { opus: 600 }),
      day('2026-10-15', { opus: 3000, haiku: 2400 }),
      day('2026-10-16', { opus: 6000 }),
    ];
    expect(averageTokensPerDay(days, NOW)).toBe(200);
  });

  it('averages someone newer than the window over the days since their first', () => {
    const days = [day('2026-10-07', { opus: 4000 }), day('2026-10-14', { opus: 6000 })];
    expect(averageTokensPerDay(days, NOW)).toBe(1000);
  });

  it('counts days with activity but no tokens toward the span', () => {
    const days = [day('2026-10-15', {}), day('2026-10-16', { opus: 500 })];
    expect(averageTokensPerDay(days, NOW)).toBe(250);
  });
});
