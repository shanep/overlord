// cspell:ignore KMBT
import { assert, integer, property } from 'fast-check';
import { describe, expect, it } from 'vitest';

import { missingValue } from '../test/render.js';

import {
  formatBytes,
  formatAgo,
  formatClock,
  formatCompact,
  formatCost,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatPercent,
  formatRate,
  formatUsd,
  formatValue,
  truncate,
} from './format.js';

describe('formatCompact', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [12.34, '12.3'],
    [950, '950'],
    [1000, '1K'],
    [1234, '1.2K'],
    [34_000, '34K'],
    [123_456, '123K'],
    [5_600_000, '5.6M'],
    [2_000_000_000, '2B'],
    [3e12, '3T'],
    [-1500, '-1.5K'],
    [999_960, '1M'],
    [999.6, '1K'],
  ])('formats %d as %s', (value, expected) => {
    expect(formatCompact(value)).toBe(expected);
  });

  it('reads non finite numbers as n/a', () => {
    expect(formatCompact(Number.NaN)).toBe('n/a');
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe('n/a');
  });

  it('never prints more than four significant characters before the suffix', () => {
    assert(
      property(integer({ min: 0, max: 9e14 }), (value) => {
        expect(formatCompact(value)).toMatch(/^\d{1,3}(?:\.\d)?[KMBT]?$/u);
      }),
    );
  });
});

describe('formatInteger', () => {
  it('groups thousands and rounds', () => {
    expect(formatInteger(1_234_567.6)).toBe('1,234,568');
    expect(formatInteger(0)).toBe('0');
  });

  it('reads non finite numbers as n/a', () => {
    expect(formatInteger(Number.NaN)).toBe('n/a');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [850, '850ms'],
    [12_400, '12s'],
    [245_000, '4m 05s'],
    [3_720_000, '1h 02m'],
    [100_800_000, '1d 4h'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('reads null, negative and non finite values as n/a', () => {
    expect(formatDuration(null)).toBe('n/a');
    expect(formatDuration(-1)).toBe('n/a');
    expect(formatDuration(Number.NaN)).toBe('n/a');
  });
});

describe('formatUsd and formatCost', () => {
  it('formats dollars with two decimals', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(12.3)).toBe('$12.30');
  });

  it('compacts large amounts and floors tiny ones', () => {
    expect(formatUsd(1234)).toBe('$1.2K');
    expect(formatUsd(-2500)).toBe('$-2.5K');
    expect(formatUsd(0.004)).toBe('<$0.01');
  });

  it('marks cost as an estimate', () => {
    expect(formatCost(1.5)).toBe('$1.50 est.');
    expect(formatCost(null)).toBe('n/a');
    expect(formatCost(Number.NaN)).toBe('n/a');
  });
});

describe('formatPercent', () => {
  it('rounds a ratio to a whole percent', () => {
    expect(formatPercent(0.424)).toBe('42%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(null)).toBe('n/a');
    expect(formatPercent(Number.NaN)).toBe('n/a');
  });
});

describe('formatClock and formatDateTime', () => {
  it('uses local 24 hour time with padding', () => {
    const at = new Date(2026, 0, 5, 9, 5, 7).getTime();
    expect(formatClock(at)).toBe('09:05:07');
    expect(formatDateTime(at)).toBe('2026-01-05 09:05');
  });
});

describe('formatAgo', () => {
  const now = 10_000_000_000;

  it.each([
    [now - 5000, 'just now'],
    [now - 5 * 60_000, '5m ago'],
    [now - 3 * 3_600_000, '3h ago'],
    [now - 2 * 86_400_000, '2d ago'],
  ])('formats %d as %s', (at, expected) => {
    expect(formatAgo(at, now)).toBe(expected);
  });
});

describe('formatValue', () => {
  it('shows strings plainly and everything else as JSON', () => {
    expect(formatValue('opus')).toBe('opus');
    expect(formatValue(5)).toBe('5');
    expect(formatValue(true)).toBe('true');
    expect(formatValue({ a: [1] })).toBe('{"a":[1]}');
    expect(formatValue(null)).toBe('null');
    expect(formatValue(missingValue())).toBe('unset');
  });
});

describe('truncate', () => {
  it('keeps short text and cuts long text with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate('abc', 0)).toBe('…');
  });
});

describe('formatBytes and formatRate', () => {
  it('steps up in powers of 1024', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1.5 * 1024 ** 2)).toBe('1.5 MB');
    expect(formatBytes(1023.9 * 1024)).toBe('1 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2 TB');
  });

  it('reads null and non-finite values as n/a', () => {
    expect(formatBytes(null)).toBe('n/a');
    expect(formatBytes(Number.NaN)).toBe('n/a');
    expect(formatRate(null)).toBe('n/a');
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe('n/a');
    expect(formatRate(0)).toBe('0 B/s');
  });
});
