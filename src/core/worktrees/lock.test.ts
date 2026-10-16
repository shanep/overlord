import { describe, expect, it } from 'vitest';

import { KeyedLock } from './lock.js';

function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  const opens: (() => void)[] = [];
  const wait = new Promise<void>((resolve) => {
    opens.push(resolve);
  });
  return {
    wait,
    open: (): void => {
      for (const open of opens) {
        open();
      }
    },
  };
}

describe('KeyedLock', () => {
  it('runs tasks under one key in order, even after a failure', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const first = gate();
    const one = lock.run('repo', async () => {
      await first.wait;
      order.push('one');
      throw new Error('one failed');
    });
    const two = lock.run('repo', async () => {
      await Promise.resolve();
      order.push('two');
      return 2;
    });
    first.open();
    await expect(one).rejects.toThrow('one failed');
    await expect(two).resolves.toBe(2);
    expect(order).toStrictEqual(['one', 'two']);
  });

  it('lets different keys run side by side', async () => {
    const lock = new KeyedLock();
    const blocked = gate();
    const order: string[] = [];
    const slow = lock.run('a', async () => {
      await blocked.wait;
      order.push('a');
    });
    await lock.run('b', async () => {
      await Promise.resolve();
      order.push('b');
    });
    blocked.open();
    await slow;
    expect(order).toStrictEqual(['b', 'a']);
  });
});
