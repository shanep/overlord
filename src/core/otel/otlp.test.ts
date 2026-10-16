import { describe, expect, it } from 'vitest';

import {
  anyValue,
  attributesOf,
  nanosToMs,
  readBool,
  readNumber,
  readString,
  toNumber,
} from './otlp.js';

// A value that is undefined without writing the literal.
const UNSET: unknown = Reflect.get({}, 'unset');

describe('toNumber', () => {
  it('accepts finite numbers and numeric strings', () => {
    expect(toNumber(3.5)).toBe(3.5);
    expect(toNumber(0)).toBe(0);
    expect(toNumber('42')).toBe(42);
    expect(toNumber(' 7 ')).toBe(7);
    expect(toNumber('-1.25')).toBe(-1.25);
  });

  it('rejects everything else', () => {
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber(' '.repeat(3))).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toNumber('Infinity')).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(UNSET)).toBeNull();
    expect(toNumber(true)).toBeNull();
  });
});

describe('nanosToMs', () => {
  it('converts nanoseconds and treats zero as unset', () => {
    expect(nanosToMs('1700000000123456789')).toBe(1_700_000_000_123);
    expect(nanosToMs(1_500_000)).toBe(1);
    expect(nanosToMs(1_999_999)).toBe(1);
    expect(nanosToMs('0')).toBeNull();
    expect(nanosToMs('000')).toBeNull();
    expect(nanosToMs('1')).toBe(0);
    expect(nanosToMs('2999999')).toBe(2);
    expect(nanosToMs('1700000000250000000')).toBe(1_700_000_000_250);
    expect(nanosToMs('-5')).toBeNull();
    expect(nanosToMs('1.5e9')).toBe(1500);
    expect(nanosToMs(-5)).toBeNull();
    expect(nanosToMs(1)).toBe(0);
    expect(nanosToMs(UNSET)).toBeNull();
  });
});

describe('anyValue', () => {
  it('converts every AnyValue kind', () => {
    expect(anyValue({ stringValue: 'x' })).toBe('x');
    expect(anyValue({ stringValue: '' })).toBe('');
    expect(anyValue({ bytesValue: 'AAE=' })).toBe('AAE=');
    expect(anyValue({ boolValue: false })).toBe(false);
    expect(anyValue({ boolValue: true })).toBe(true);
    expect(anyValue({ intValue: '12' })).toBe(12);
    expect(anyValue({ intValue: 3 })).toBe(3);
    expect(anyValue({ doubleValue: 0.5 })).toBe(0.5);
    expect(anyValue({ doubleValue: 'NaN' })).toBeNull();
    expect(
      anyValue({ arrayValue: { values: [{ stringValue: 'a' }, { intValue: 1 }] } }),
    ).toStrictEqual(['a', 1]);
    expect(anyValue({ arrayValue: {} })).toStrictEqual([]);
    expect(anyValue({ arrayValue: null })).toStrictEqual([]);
    expect(
      anyValue({
        kvlistValue: { values: [{ key: 'k', value: { boolValue: true } }, { nokey: 1 }] },
      }),
    ).toStrictEqual({ k: true });
  });

  it('is null for empty or unknown values', () => {
    expect(anyValue({})).toBeNull();
    expect(anyValue(null)).toBeNull();
    expect(anyValue('x')).toBeNull();
    expect(anyValue([])).toBeNull();
    expect(anyValue({ boolValue: 'true' })).toBeNull();
    expect(anyValue({ stringValue: 4 })).toBeNull();
  });
});

describe('attributesOf', () => {
  it('builds a record and skips malformed entries', () => {
    expect(
      attributesOf([
        { key: 'a', value: { stringValue: 'x' } },
        { key: 'b' },
        { value: { stringValue: 'lost' } },
        { key: 3, value: {} },
        'junk',
        null,
      ]),
    ).toStrictEqual({ a: 'x', b: null });
    expect(attributesOf([])).toStrictEqual({});
  });
});

describe('attribute readers', () => {
  const attributes = {
    s: 'v',
    n: 5,
    ns: '6',
    t: 'true',
    f: 'false',
    b: true,
    x: null,
    list: ['a'],
  };

  it('reads strings, turning numbers into strings', () => {
    expect(readString(attributes, 's')).toBe('v');
    expect(readString(attributes, 'n')).toBe('5');
    expect(readString(attributes, 'b')).toBeNull();
    expect(readString(attributes, 'x')).toBeNull();
    expect(readString(attributes, 'missing')).toBeNull();
  });

  it('reads numbers from numbers and numeric strings', () => {
    expect(readNumber(attributes, 'n')).toBe(5);
    expect(readNumber(attributes, 'ns')).toBe(6);
    expect(readNumber(attributes, 's')).toBeNull();
    expect(readNumber(attributes, 'list')).toBeNull();
  });

  it('reads booleans from booleans and "true"/"false"', () => {
    expect(readBool(attributes, 'b')).toBe(true);
    expect(readBool(attributes, 't')).toBe(true);
    expect(readBool(attributes, 'f')).toBe(false);
    expect(readBool(attributes, 's')).toBeNull();
    expect(readBool(attributes, 'n')).toBeNull();
    expect(readBool({ no: false }, 'no')).toBe(false);
  });
});
