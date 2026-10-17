import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE, CODEX } from '../../shared/agents.js';
import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';
import type { ModelPrice } from '../transcripts/pricing.js';

import {
  DEFAULT_OUTPUT_TOKENS,
  DEFAULT_OVERHEAD_TOKENS,
  estimateBatch,
  estimateTokens,
  type AgentPrices,
} from './estimate.js';

function perMTok(input: number, output: number): ModelPrice {
  return { input, output, cacheRead: 0, cacheWrite: 0 };
}

const prices: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-4-6[1m]': perMTok(5, 25),
  sonnet: perMTok(3, 15),
};

/** Claude Code with the table above, and every other agent with no prices. */
function pricesFor(defaultModel: string): (agent: string) => AgentPrices {
  return (agent) =>
    agent === CLAUDE_CODE
      ? { price: (model) => prices[model] ?? null, defaultModel }
      : { price: () => null, defaultModel: 'gpt-6-luna' };
}

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

describe('estimateBatch', () => {
  it('prices each run and sums the batch', () => {
    const estimate = estimateBatch([spec('abcd', 'opus'), spec('abcdefgh', null)], [opus], {
      pricesFor: pricesFor('sonnet'),
      overheadTokens: 99,
      outputTokens: 1000,
      requests: 2,
    });
    expect(estimate.runs).toStrictEqual([
      {
        label: 'abcd',
        agent: CLAUDE_CODE,
        model: 'claude-opus-4-6[1m]',
        inputTokens: 200,
        outputTokens: 2000,
        usd: (200 * 5 + 2000 * 25) / 1e6,
      },
      {
        label: 'abcdefgh',
        agent: CLAUDE_CODE,
        model: 'sonnet',
        inputTokens: 202,
        outputTokens: 2000,
        usd: (202 * 3 + 2000 * 15) / 1e6,
      },
    ]);
    expect(estimate.totalUsd).toBeCloseTo((200 * 5 + 2000 * 25 + 202 * 3 + 2000 * 15) / 1e6, 12);
    expect(estimate.unpricedRuns).toBe(0);
    expect(estimate.unpricedModels).toStrictEqual([]);
  });

  it('uses the defaults and reports unpriced models once', () => {
    const estimate = estimateBatch([spec('x', null), spec('y', null)], [], {
      pricesFor: pricesFor('mystery'),
    });
    expect(estimate.runs[0]).toStrictEqual({
      label: 'x',
      agent: CLAUDE_CODE,
      model: 'mystery',
      inputTokens: 1 + DEFAULT_OVERHEAD_TOKENS,
      outputTokens: DEFAULT_OUTPUT_TOKENS,
      usd: null,
    });
    expect(estimate.totalUsd).toBe(0);
    expect(estimate.unpricedRuns).toBe(2);
    expect(estimate.unpricedModels).toStrictEqual(['mystery']);
    expect(DEFAULT_OVERHEAD_TOKENS).toBe(15_000);
    expect(DEFAULT_OUTPUT_TOKENS).toBe(2000);
  });

  it('falls back to the default model when the profile has none', () => {
    const plain: LaunchProfile = { ...opus, model: null };
    const estimate = estimateBatch([spec('x', 'opus')], [plain], {
      pricesFor: pricesFor('sonnet'),
    });
    expect(estimate.runs[0]?.model).toBe('sonnet');
  });

  it("prices each run by its own agent, and leaves an unpriced agent's runs unknown", () => {
    const codex: LaunchProfile = { ...opus, id: 'codex', agent: CODEX, model: null };
    const estimate = estimateBatch([spec('abcd', 'opus'), spec('abcd', 'codex')], [opus, codex], {
      pricesFor: pricesFor('sonnet'),
    });
    expect(estimate.runs.map((run) => [run.agent, run.model, run.usd === null])).toStrictEqual([
      [CLAUDE_CODE, 'claude-opus-4-6[1m]', false],
      [CODEX, 'gpt-6-luna', true],
    ]);
    expect(estimate.totalUsd).toBe(estimate.runs[0]?.usd);
    expect(estimate.unpricedRuns).toBe(1);
  });
});
