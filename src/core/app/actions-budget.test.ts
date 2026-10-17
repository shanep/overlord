import { describe, expect, it } from 'vitest';

import { ZERO_USAGE } from '../../shared/model.js';

import { parseTokens } from './actions-budget.js';
import { makeApp, makeEnv, session } from './test-helpers/fixtures.js';

describe('parseTokens', () => {
  it('reads amounts with a K, M or B suffix, commas and underscores', () => {
    expect(parseTokens('500M')).toBe(500_000_000);
    expect(parseTokens(' 1.5b ')).toBe(1_500_000_000);
    expect(parseTokens('200k')).toBe(200_000);
    expect(parseTokens('250,000')).toBe(250_000);
    expect(parseTokens('1_000 m')).toBe(1_000_000_000);
  });

  it('is null for anything else, and for zero', () => {
    expect(parseTokens('lots')).toBeNull();
    expect(parseTokens('5T')).toBeNull();
    expect(parseTokens('-5M')).toBeNull();
    expect(parseTokens('0')).toBeNull();
  });
});

describe('setBudget', () => {
  it('asks with what the session has used, saves the budget and clears it when left empty', async () => {
    const env = await makeEnv();
    const test = makeApp(env);
    test.bus.emit(
      'session.upserted',
      session('s1', { title: 'Big run', usage: { ...ZERO_USAGE, input: 2_000_000 } }),
    );
    env.host.inputAnswers.push('500m');
    await test.app.dispatch({ type: 'setBudget', sessionId: 's1' }, {});
    expect(env.host.inputs).toStrictEqual([
      {
        prompt:
          'Token budget for Big run, such as 500M. Leave it empty for none. It has used 2M so far.',
        value: '',
      },
    ]);
    expect(test.app.runtime.budgets.get('s1')).toBe(500_000_000);
    expect(test.app.stateFor('fleet', {})).toMatchObject({
      state: { progress: { s1: { budget: { tokens: 500_000_000, used: 2_000_000 } } } },
    });

    env.host.inputAnswers.push('');
    await test.app.dispatch({ type: 'setBudget', sessionId: 's1' }, {});
    expect(env.host.inputs.at(-1)?.value).toBe('500M');
    expect(test.app.runtime.budgets.get('s1')).toBeNull();
  });

  it('keeps the budget when cancelled and says so when the amount is not one', async () => {
    const env = await makeEnv();
    const test = makeApp(env);
    await test.app.runtime.budgets.set('s1', 1000);
    await test.app.dispatch({ type: 'setBudget', sessionId: 's1' }, {});
    env.host.inputAnswers.push('heaps');
    await test.app.dispatch({ type: 'setBudget', sessionId: 's1' }, {});
    expect(env.host.inputs[0]?.prompt).toContain('for this session,');
    expect(test.app.runtime.budgets.get('s1')).toBe(1000);
    expect(env.host.warnings).toStrictEqual([
      '"heaps" is not a token amount. Try something like 500M or 2B.',
    ]);
  });
});
