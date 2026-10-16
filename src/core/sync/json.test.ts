import { describe, expect, it } from 'vitest';

import {
  compareStrings,
  isArray,
  isRecord,
  jsonEqual,
  parseJson,
  sortKeysDeep,
  stableJson,
  stringRecord,
} from './json.js';

describe('guards', () => {
  it('tells records from arrays and null', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isArray([])).toBe(true);
    expect(isArray({})).toBe(false);
  });
});

describe('parseJson', () => {
  it('parses or returns undefined', () => {
    expect(parseJson('{"a":1}')).toStrictEqual({ a: 1 });
    expect(parseJson('nope')).toBeUndefined();
  });
});

describe('compareStrings', () => {
  it('orders by code unit', () => {
    expect(compareStrings('a', 'a')).toBe(0);
    expect(compareStrings('B', 'a')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
    expect(['b', 'a', 'C'].toSorted(compareStrings)).toStrictEqual(['C', 'a', 'b']);
  });
});

describe('sorted JSON', () => {
  it('sorts keys at every depth and keeps array order', () => {
    const value = { b: 1, a: { d: [{ z: 1, y: 2 }], c: null } };
    expect(JSON.stringify(sortKeysDeep(value))).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
    expect(stableJson({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });

  it('compares ignoring key order', () => {
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});

describe('stringRecord', () => {
  it('keeps only string values', () => {
    expect(stringRecord({ a: 'x', b: 1, c: null })).toStrictEqual({ a: 'x' });
    expect(stringRecord(['a'])).toStrictEqual({});
  });
});
