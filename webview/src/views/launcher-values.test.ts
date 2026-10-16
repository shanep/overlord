import { describe, expect, it } from 'vitest';

import { knobsState } from '../../test/fixtures-context.js';
import { launcherState } from '../../test/fixtures-tools.js';

import type { LaunchForm } from './launcher-values.js';
import {
  buildSpecs,
  isActiveRun,
  parseBudget,
  runCountLabel,
  runLabel,
} from './launcher-values.js';

const form: LaunchForm = {
  prompt: 'Fix the bug\nThen run the tests',
  label: '',
  cwd: ' /repo ',
  worktree: true,
  maxBudgetUsd: 2,
};

describe('parseBudget', () => {
  it('reads empty as no budget', () => {
    expect(parseBudget('  ')).toStrictEqual({ ok: true, value: null });
  });

  it('reads positive dollars', () => {
    expect(parseBudget('2.5')).toStrictEqual({ ok: true, value: 2.5 });
  });

  it('rejects zero, negative and non numbers', () => {
    const error = { ok: false, error: 'Budget must be a positive number.' };
    expect(parseBudget('0')).toStrictEqual(error);
    expect(parseBudget('-1')).toStrictEqual(error);
    expect(parseBudget('abc')).toStrictEqual(error);
  });
});

describe('runLabel', () => {
  it('uses the label when given', () => {
    expect(runLabel({ ...form, label: ' Bug fix ' })).toBe('Bug fix');
  });

  it('falls back to the first prompt line, cut short', () => {
    expect(runLabel(form)).toBe('Fix the bug');
    expect(runLabel({ ...form, prompt: 'x'.repeat(50) })).toBe(`${'x'.repeat(39)}…`);
    expect(runLabel({ ...form, prompt: '' })).toBe('');
  });
});

describe('buildSpecs', () => {
  const [fast, deep] = knobsState.profiles;

  it('makes one spec with no profile when none is selected', () => {
    expect(buildSpecs(form, [])).toStrictEqual([
      {
        prompt: form.prompt,
        cwd: '/repo',
        worktree: true,
        maxBudgetUsd: 2,
        profileId: null,
        label: 'Fix the bug',
      },
    ]);
  });

  it('makes one spec per selected profile, naming each in a matrix', () => {
    if (fast === undefined || deep === undefined) {
      throw new Error('fixture profiles missing');
    }
    expect(buildSpecs(form, [fast]).map((spec) => [spec.profileId, spec.label])).toStrictEqual([
      ['p1', 'Fix the bug'],
    ]);
    expect(
      buildSpecs(form, [fast, deep]).map((spec) => [spec.profileId, spec.label]),
    ).toStrictEqual([
      ['p1', 'Fix the bug (Fast)'],
      ['p2', 'Fix the bug (Deep)'],
    ]);
  });
});

describe('runCountLabel and isActiveRun', () => {
  it('pluralizes', () => {
    expect(runCountLabel(1)).toBe('1 run');
    expect(runCountLabel(3)).toBe('3 runs');
  });

  it('treats queued and running as active', () => {
    const [running, done] = launcherState.runs;
    if (running === undefined || done === undefined) {
      throw new Error('fixture runs missing');
    }
    expect(isActiveRun(running)).toBe(true);
    expect(isActiveRun({ ...running, state: 'queued' })).toBe(true);
    expect(isActiveRun(done)).toBe(false);
    expect(isActiveRun({ ...done, state: 'stopped' })).toBe(false);
  });
});
