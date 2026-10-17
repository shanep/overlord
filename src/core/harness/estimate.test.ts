import { describe, expect, it } from 'vitest';

import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';

import {
  DEFAULT_OUTPUT_TOKENS,
  DEFAULT_OVERHEAD_TOKENS,
  estimateBatch,
  estimateTokens,
  findPrice,
  type PriceTable,
} from './estimate.js';

const prices: PriceTable = {
  'claude-opus': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-opus-4': { inputPerMTok: 5, outputPerMTok: 25 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
};

function spec(prompt: string, profileId: string | null): LaunchSpec {
  return { prompt, cwd: '/r', profileId, worktree: false, maxBudgetUsd: null, label: prompt };
}

const opus: LaunchProfile = {
  id: 'opus',
  agent: 'claude-code',
  name: 'Opus',
  model: 'claude-opus-4-6[1m]',
  effort: null,
  permissionMode: null,
  env: {},
  extraArgs: [],
};

describe('estimateTokens', () => {
  it('counts four characters per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('findPrice', () => {
  it('prefers an exact match, then the longest prefix', () => {
    expect(findPrice(prices, 'sonnet')).toBe(prices['sonnet']);
    expect(findPrice(prices, 'claude-opus-4-6')).toBe(prices['claude-opus-4']);
    expect(findPrice(prices, 'claude-opus-3')).toBe(prices['claude-opus']);
    expect(
      findPrice(
        {
          b: { inputPerMTok: 1, outputPerMTok: 1 },
          'b-long': { inputPerMTok: 2, outputPerMTok: 2 },
          'b-': { inputPerMTok: 3, outputPerMTok: 3 },
        },
        'b-long-x',
      ),
    ).toStrictEqual({ inputPerMTok: 2, outputPerMTok: 2 });
    expect(findPrice(prices, 'haiku')).toBeNull();
  });
});

describe('estimateBatch', () => {
  it('prices each run and sums the batch', () => {
    const estimate = estimateBatch([spec('abcd', 'opus'), spec('abcdefgh', null)], [opus], {
      prices,
      defaultModel: 'sonnet',
      overheadTokens: 99,
      outputTokens: 1000,
      requests: 2,
    });
    expect(estimate.runs).toStrictEqual([
      {
        label: 'abcd',
        model: 'claude-opus-4-6[1m]',
        inputTokens: 200,
        outputTokens: 2000,
        usd: (200 * 5 + 2000 * 25) / 1e6,
      },
      {
        label: 'abcdefgh',
        model: 'sonnet',
        inputTokens: 202,
        outputTokens: 2000,
        usd: (202 * 3 + 2000 * 15) / 1e6,
      },
    ]);
    expect(estimate.totalUsd).toBeCloseTo((200 * 5 + 2000 * 25 + 202 * 3 + 2000 * 15) / 1e6, 12);
    expect(estimate.unpricedModels).toStrictEqual([]);
  });

  it('uses the defaults and reports unpriced models once', () => {
    const estimate = estimateBatch([spec('x', null), spec('y', null)], [], {
      prices: {},
      defaultModel: 'mystery',
    });
    expect(estimate.runs[0]).toStrictEqual({
      label: 'x',
      model: 'mystery',
      inputTokens: 1 + DEFAULT_OVERHEAD_TOKENS,
      outputTokens: DEFAULT_OUTPUT_TOKENS,
      usd: null,
    });
    expect(estimate.totalUsd).toBe(0);
    expect(estimate.unpricedModels).toStrictEqual(['mystery']);
    expect(DEFAULT_OVERHEAD_TOKENS).toBe(15_000);
    expect(DEFAULT_OUTPUT_TOKENS).toBe(2000);
  });

  it('falls back to the default model when the profile has none', () => {
    const plain: LaunchProfile = { ...opus, model: null };
    const estimate = estimateBatch([spec('x', 'opus')], [plain], {
      prices,
      defaultModel: 'sonnet',
    });
    expect(estimate.runs[0]?.model).toBe('sonnet');
  });
});
