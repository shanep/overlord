import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE, CODEX } from '../../shared/agents.js';
import type { RateLimitEvent } from '../agents/shared/events.js';

import { applyRateLimit, NO_RATE_LIMITS, windowLabel } from './nodes.js';

function report(
  id: string,
  usedPct: number | null,
  windowMinutes: number | null = null,
): RateLimitEvent {
  return { type: 'rate_limit', windows: [{ id, usedPct, resetsAt: null, windowMinutes }] };
}

describe('windowLabel', () => {
  it('names a window by its length, else by its id', () => {
    expect(windowLabel('primary', 300)).toBe('5 hour');
    expect(windowLabel('secondary', 10_080)).toBe('7 day');
    expect(windowLabel('monthly', 43_200)).toBe('30 day');
    expect(windowLabel('burst', 90)).toBe('90 minute');
    expect(windowLabel('five_hour', null)).toBe('5 hour');
    expect(windowLabel('some_window', 0)).toBe('some window');
  });
});

describe('applyRateLimit', () => {
  it("keeps another agent's windows apart from Claude Code's fields", () => {
    const first = applyRateLimit(NO_RATE_LIMITS, report('five_hour', 40, 300), CODEX);
    expect(first).toStrictEqual({
      fiveHourPct: null,
      sevenDayPct: null,
      resetsAt: null,
      windows: [{ agent: CODEX, id: 'five_hour', label: '5 hour', usedPct: 40, resetsAt: null }],
    });
    const second = applyRateLimit(first ?? NO_RATE_LIMITS, report('five_hour', null, 300), CODEX);
    expect(second?.windows?.[0]?.usedPct).toBe(40);
    const claude = applyRateLimit(second ?? NO_RATE_LIMITS, report('five_hour', 10), CLAUDE_CODE);
    expect(claude?.fiveHourPct).toBe(10);
    expect(claude?.windows?.map((window) => `${window.agent}:${window.id}`)).toStrictEqual([
      'codex:five_hour',
      'claude-code:five_hour',
    ]);
  });

  it('returns null for a report with no windows', () => {
    expect(applyRateLimit(NO_RATE_LIMITS, { type: 'rate_limit', windows: [] }, CODEX)).toBeNull();
  });
});
