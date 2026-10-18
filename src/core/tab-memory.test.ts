import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { forgetTab, parseStoredTabs, rememberTab, restoreTabs } from './tab-memory.js';

describe('parseStoredTabs', () => {
  it('reads a pid to session map and rejects anything else', () => {
    expect(parseStoredTabs({ '123': 'abc' })).toStrictEqual({ '123': { sessionId: 'abc' } });
    expect(
      parseStoredTabs({ '123': { sessionId: 'abc', worktreeId: 'worktree-1' } }),
    ).toStrictEqual({
      '123': { sessionId: 'abc', worktreeId: 'worktree-1' },
    });
    expect(parseStoredTabs(null)).toStrictEqual({});
    expect(parseStoredTabs([1, 2])).toStrictEqual({});
    expect(parseStoredTabs({ x: 'abc' })).toStrictEqual({});
    expect(parseStoredTabs({ '12': '' })).toStrictEqual({});
    expect(parseStoredTabs({ '12': 7 })).toStrictEqual({});
  });
});

describe('rememberTab and forgetTab', () => {
  it('adds, replaces and removes one tab without touching the others', () => {
    const one = rememberTab({}, 10, 's1');
    const two = rememberTab(one, 20, 's2', 'worktree-2');
    expect(two).toStrictEqual({
      '10': { sessionId: 's1' },
      '20': { sessionId: 's2', worktreeId: 'worktree-2' },
    });
    expect(rememberTab(two, 10, 's3', 'worktree-3')).toStrictEqual({
      '10': { sessionId: 's3', worktreeId: 'worktree-3' },
      '20': { sessionId: 's2', worktreeId: 'worktree-2' },
    });
    expect(forgetTab(two, 10)).toStrictEqual({
      '20': { sessionId: 's2', worktreeId: 'worktree-2' },
    });
    expect(forgetTab(two, 99)).toStrictEqual(two);
    expect(one).toStrictEqual({ '10': { sessionId: 's1' } });
  });
});

describe('restoreTabs', () => {
  it('matches the terminals that came back and drops the ones that did not', () => {
    const restored = restoreTabs(
      {
        '10': { sessionId: 's1' },
        '20': { sessionId: 's2' },
        '30': { sessionId: 's3', worktreeId: 'worktree-3' },
      },
      [30, 10, 40],
    );
    expect([...restored.matched]).toStrictEqual([
      [30, { sessionId: 's3', worktreeId: 'worktree-3' }],
      [10, { sessionId: 's1' }],
    ]);
    expect(restored.kept).toStrictEqual({
      '30': { sessionId: 's3', worktreeId: 'worktree-3' },
      '10': { sessionId: 's1' },
    });
  });

  it('keeps exactly the stored entries whose pid is open', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.integer({ min: 1, max: 500 }).map(String),
          fc
            .record({
              sessionId: fc.string({ minLength: 1 }),
              worktreeId: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
            })
            .map(({ sessionId, worktreeId }) =>
              worktreeId === undefined ? { sessionId } : { sessionId, worktreeId },
            ),
        ),
        fc.uniqueArray(fc.integer({ min: 1, max: 500 })),
        (stored, open) => {
          const { matched, kept } = restoreTabs(stored, open);
          for (const [key, tab] of Object.entries(stored)) {
            const isOpen = open.includes(Number(key));
            expect(matched.get(Number(key))).toStrictEqual(isOpen ? tab : undefined);
            expect(kept[key]).toStrictEqual(isOpen ? tab : undefined);
          }
          expect(Object.keys(kept)).toHaveLength(matched.size);
        },
      ),
    );
  });
});
