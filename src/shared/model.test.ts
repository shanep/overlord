import { describe, expect, it } from 'vitest';

import { contextWindow, promptTokens, ZERO_USAGE } from './model.js';

describe('ZERO_USAGE', () => {
  it('has every counter at zero', () => {
    expect(ZERO_USAGE).toStrictEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      thinking: 0,
    });
  });
});

describe('promptTokens', () => {
  it('counts input read fresh and from the cache', () => {
    expect(
      promptTokens({ input: 10, output: 99, cacheRead: 300, cacheCreation: 130, thinking: 5 }),
    ).toBe(440);
  });
});

describe('contextWindow', () => {
  it('gives the 1M window to the models that run it by default', () => {
    for (const model of [
      'claude-opus-4-7',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-sonnet-6',
      'claude-haiku-5-5',
      'claude-haiku-6-0',
      'claude-fable-5-1',
    ]) {
      expect({ model, window: contextWindow(model) }).toStrictEqual({ model, window: 1_000_000 });
    }
  });

  it('gives 200K to older models, dated ids and ids it does not know', () => {
    for (const model of [
      'claude-opus-4-6',
      'claude-opus-4-20250514',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-haiku-5',
      'claude-3-5-sonnet-20241022',
      'gateway-model',
    ]) {
      expect({ model, window: contextWindow(model) }).toStrictEqual({ model, window: 200_000 });
    }
  });

  it('trusts the [1m] tag and a prompt too big for 200K', () => {
    expect(contextWindow('claude-opus-4-6[1m]')).toBe(1_000_000);
    expect(contextWindow('gateway-model', 250_000)).toBe(1_000_000);
    expect(contextWindow(null, 250_000)).toBe(1_000_000);
  });

  it('is unknown without a model', () => {
    expect(contextWindow(null)).toBeNull();
    expect(contextWindow(null, 150_000)).toBeNull();
  });
});
