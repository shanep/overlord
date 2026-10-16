import { describe, expect, it, vi } from 'vitest';

import { SessionScoped } from './scoped.js';

describe('SessionScoped', () => {
  it('stores values by session and agent', () => {
    const scoped = new SessionScoped<string>();
    scoped.set('s1', 'a1', 'x');
    scoped.set('s1', 'a2', 'y');
    scoped.set('s2', 'a1', 'z');
    expect(scoped.get('s1', 'a1')).toBe('x');
    expect(scoped.get('s2', 'a1')).toBe('z');
    expect(scoped.get('s2', 'a2')).toBeUndefined();
    expect(scoped.get('s3', 'a1')).toBeUndefined();
    expect(scoped.inSession('s1')).toStrictEqual(['x', 'y']);
    expect(scoped.inSession('s3')).toStrictEqual([]);
    expect(scoped.all()).toStrictEqual(['x', 'y', 'z']);
  });

  it('replaces a value for the same key', () => {
    const scoped = new SessionScoped<number>();
    scoped.set('s', 'a', 1);
    scoped.set('s', 'a', 2);
    expect(scoped.all()).toStrictEqual([2]);
  });

  it('creates a value only when missing', () => {
    const scoped = new SessionScoped<number[]>();
    const create = vi.fn((): number[] => []);
    const first = scoped.getOrCreate('s', 'a', create);
    const second = scoped.getOrCreate('s', 'a', create);
    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(scoped.get('s', 'a')).toBe(first);
  });

  it('drops a whole session', () => {
    const scoped = new SessionScoped<string>();
    scoped.set('s1', 'a', 'x');
    scoped.set('s2', 'a', 'y');
    scoped.deleteSession('s1');
    expect(scoped.all()).toStrictEqual(['y']);
    expect(scoped.get('s1', 'a')).toBeUndefined();
  });
});
