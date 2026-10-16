import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BoundedMap, RingBuffer } from './ring.js';

function pushAll<T>(ring: RingBuffer<T>, values: readonly T[]): void {
  for (const value of values) {
    ring.push(value);
  }
}

function setAll<V>(map: BoundedMap<string, V>, entries: readonly (readonly [string, V])[]): void {
  for (const [key, value] of entries) {
    map.set(key, value);
  }
}

describe('RingBuffer', () => {
  it('rejects a capacity that is not a positive whole number', () => {
    expect(() => new RingBuffer(0)).toThrow(
      new RangeError('Capacity must be a whole number of at least 1, got 0.'),
    );
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
    expect(() => new RingBuffer(Number.NaN)).toThrow(RangeError);
    expect(new RingBuffer(1).capacity).toBe(1);
  });

  it('keeps items in order until full', () => {
    const ring = new RingBuffer<string>(3);
    expect(ring.toArray()).toStrictEqual([]);
    pushAll(ring, ['a', 'b']);
    expect(ring.toArray()).toStrictEqual(['a', 'b']);
    expect(ring.size).toBe(2);
  });

  it('overwrites the oldest item once full', () => {
    const ring = new RingBuffer<number>(3);
    pushAll(ring, [1, 2, 3, 4, 5]);
    expect(ring.toArray()).toStrictEqual([3, 4, 5]);
    expect(ring.size).toBe(3);
    pushAll(ring, [6, 7]);
    expect(ring.toArray()).toStrictEqual([5, 6, 7]);
  });

  it('never exceeds capacity and keeps the newest items in order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.integer(), { maxLength: 60 }),
        (capacity, values) => {
          const ring = new RingBuffer<number>(capacity);
          for (const [index, value] of values.entries()) {
            ring.push(value);
            expect(ring.size).toBe(Math.min(index + 1, capacity));
          }
          expect(ring.size).toBeLessThanOrEqual(capacity);
          expect(ring.toArray()).toStrictEqual(values.slice(-capacity));
        },
      ),
    );
  });

  it('returns a copy that callers cannot use to change the buffer', () => {
    const ring = new RingBuffer<number>(2);
    ring.push(1);
    ring.toArray().push(9);
    expect(ring.toArray()).toStrictEqual([1]);
  });
});

describe('BoundedMap', () => {
  it('rejects a bad capacity', () => {
    expect(() => new BoundedMap(-1)).toThrow(
      new RangeError('Capacity must be a whole number of at least 1, got -1.'),
    );
  });

  it('drops the oldest keys past capacity', () => {
    const map = new BoundedMap<string, number>(2);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    expect(map.values()).toStrictEqual([2, 3]);
    expect(map.get('a')).toBeUndefined();
    expect(map.get('c')).toBe(3);
    expect(map.size).toBe(2);
    expect(map.capacity).toBe(2);
  });

  it('updates a key in place without changing its age', () => {
    const map = new BoundedMap<string, number>(2);
    setAll(map, [
      ['a', 1],
      ['b', 2],
      ['a', 10],
    ]);
    expect(map.values()).toStrictEqual([10, 2]);
    map.set('c', 3);
    expect(map.values()).toStrictEqual([2, 3]);
  });

  it('matches a simple model for any sequence of writes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 9 }), fc.integer()), { maxLength: 50 }),
        (capacity, writes) => {
          const map = new BoundedMap<number, number>(capacity);
          let model: [number, number][] = [];
          for (const [key, value] of writes) {
            map.set(key, value);
            const index = model.findIndex(([existing]) => existing === key);
            if (index === -1) {
              model.push([key, value]);
            } else {
              model[index] = [key, value];
            }
            model = model.slice(-capacity);
            expect(map.size).toBeLessThanOrEqual(capacity);
          }
          expect(map.values()).toStrictEqual(model.map(([, value]) => value));
        },
      ),
    );
  });
});
