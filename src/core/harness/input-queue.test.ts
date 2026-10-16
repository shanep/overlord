import { describe, expect, it } from 'vitest';

import { AsyncQueue } from './input-queue.js';

describe('AsyncQueue', () => {
  it('delivers buffered items, then waits, then ends', async () => {
    const queue = new AsyncQueue<string>();
    queue.push('a');
    expect(queue.ended).toBe(false);
    queue.push('b');
    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toStrictEqual({ done: false, value: 'a' });
    expect(await iterator.next()).toStrictEqual({ done: false, value: 'b' });
    const pending = iterator.next();
    queue.push('c');
    expect(await pending).toStrictEqual({ done: false, value: 'c' });
    const last = iterator.next();
    expect(queue.ended).toBe(false);
    queue.end();
    expect(queue.ended).toBe(true);
    expect(await last).toStrictEqual({ done: true, value: undefined });
    expect(await iterator.next()).toStrictEqual({ done: true, value: undefined });
  });

  it('drains items pushed before end', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.end();
    const seen: number[] = [];
    for await (const item of queue) {
      seen.push(item);
    }
    expect(seen).toStrictEqual([1]);
  });

  it('refuses pushes after end and tolerates a second end', () => {
    const queue = new AsyncQueue<number>();
    queue.end();
    queue.end();
    expect(() => {
      queue.push(1);
    }).toThrow('The input queue has ended');
  });
});
