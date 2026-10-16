import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { LaunchProfile } from '../../shared/model.js';

import { expandMatrix, promptSnippet } from './matrix.js';

function profile(id: string, name: string): LaunchProfile {
  return { id, name, model: null, effort: null, permissionMode: null, env: {}, extraArgs: [] };
}

describe('promptSnippet', () => {
  it('keeps the first line and cuts long ones', () => {
    expect(promptSnippet('  Fix the bug\nmore detail')).toBe('Fix the bug');
    expect(promptSnippet('a'.repeat(40))).toBe('a'.repeat(40));
    expect(promptSnippet('a'.repeat(41))).toBe(`${'a'.repeat(40)}...`);
    expect(promptSnippet('')).toBe('');
  });
});

describe('expandMatrix', () => {
  it('crosses every prompt with every profile', () => {
    const specs = expandMatrix({
      prompts: ['Fix the bug', 'Write tests'],
      profiles: [profile('a', 'Opus'), profile('b', 'Sonnet')],
      cwd: '/repo',
      worktree: true,
      maxBudgetUsd: 1.5,
    });
    expect(specs).toStrictEqual([
      {
        prompt: 'Fix the bug',
        cwd: '/repo',
        profileId: 'a',
        worktree: true,
        maxBudgetUsd: 1.5,
        label: '1. Fix the bug [Opus]',
      },
      {
        prompt: 'Fix the bug',
        cwd: '/repo',
        profileId: 'b',
        worktree: true,
        maxBudgetUsd: 1.5,
        label: '1. Fix the bug [Sonnet]',
      },
      {
        prompt: 'Write tests',
        cwd: '/repo',
        profileId: 'a',
        worktree: true,
        maxBudgetUsd: 1.5,
        label: '2. Write tests [Opus]',
      },
      {
        prompt: 'Write tests',
        cwd: '/repo',
        profileId: 'b',
        worktree: true,
        maxBudgetUsd: 1.5,
        label: '2. Write tests [Sonnet]',
      },
    ]);
  });

  it('makes one default run per prompt with no profiles and no cap', () => {
    expect(
      expandMatrix({ prompts: ['Only'], profiles: [], cwd: '/r', worktree: false }),
    ).toStrictEqual([
      {
        prompt: 'Only',
        cwd: '/r',
        profileId: null,
        worktree: false,
        maxBudgetUsd: null,
        label: '1. Only',
      },
    ]);
  });

  it('always yields prompts times max(profiles, 1) specs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 5 }),
        fc.integer({ min: 0, max: 4 }),
        (prompts, count) => {
          const profiles = Array.from({ length: count }, (_, index) =>
            profile(String(index), `P${String(index)}`),
          );
          const specs = expandMatrix({ prompts, profiles, cwd: '/r', worktree: false });
          expect(specs).toHaveLength(prompts.length * Math.max(count, 1));
        },
      ),
    );
  });
});
