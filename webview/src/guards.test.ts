import { describe, expect, it } from 'vitest';

import { isArray, isBoolean, isNumber, isRecord, isString, isStringArray } from './guards.js';

describe('guards', () => {
  it('isRecord accepts plain objects only', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('isArray, isString, isBoolean', () => {
    expect(isArray([1])).toBe(true);
    expect(isArray({})).toBe(false);
    expect(isString('')).toBe(true);
    expect(isString(1)).toBe(false);
    expect(isBoolean(false)).toBe(true);
    expect(isBoolean('false')).toBe(false);
  });

  it('isNumber rejects NaN and infinity', () => {
    expect(isNumber(3)).toBe(true);
    expect(isNumber(Number.NaN)).toBe(false);
    expect(isNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNumber('3')).toBe(false);
  });

  it('isStringArray checks every item', () => {
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(['a', 1])).toBe(false);
    expect(isStringArray('a')).toBe(false);
  });
});
