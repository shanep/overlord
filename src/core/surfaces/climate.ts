// A rough climate estimate for the usage history. Anthropic does not publish
// energy per token, so this prices each model's tokens at list price and
// turns dollars into watt hours. Price tracks compute well enough to rank
// models and token kinds (an output token costs about 5 times an input token,
// a cache read a tenth). Treat the result as a guess within about 3 times
// either way.

import type { TokenUsage } from '../../shared/model.js';
import type { ClimateAssumptions, ClimateEstimate, ModelClimate } from '../../shared/protocol.js';
import { DEFAULT_PRICES, estimateCost } from '../transcripts/pricing.js';
import type { PriceTable } from '../transcripts/pricing.js';

/**
 * Epoch AI (2025) puts a typical chat reply (about 500 output tokens on a
 * GPT-4o class model) at 0.3 Wh, and Google (2025) puts a median Gemini
 * prompt at 0.24 Wh including data center overhead. 500 output tokens at
 * Sonnet class list price ($15 per million) is $0.0075, so about 40 Wh per
 * list price dollar.
 */
export const DEFAULT_ASSUMPTIONS: ClimateAssumptions = {
  whPerListDollar: 40,
  // Close to the US grid average (EPA eGRID 2023) and a little under the world average.
  kgCo2ePerKwh: 0.4,
  // On site cooling water, the commonly cited US data center average (Lawrence Berkeley National Lab).
  litersPerKwh: 1.8,
  // Average US passenger car (EPA).
  kgCo2ePerMile: 0.4,
  // Average US home uses about 10,500 kWh a year (EIA).
  kwhPerHomeDay: 29,
};

/** Token counts for one model, as stats-cache.json keeps them. */
export interface ModelTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export function emptyClimate(
  assumptions: ClimateAssumptions = DEFAULT_ASSUMPTIONS,
): ClimateEstimate {
  return {
    energyKwh: 0,
    co2eKg: 0,
    waterLiters: 0,
    drivingMiles: 0,
    homeDays: 0,
    unpricedTokens: 0,
    models: [],
    assumptions,
  };
}

function toUsage(tokens: ModelTokens): TokenUsage {
  return {
    input: tokens.inputTokens,
    output: tokens.outputTokens,
    cacheRead: tokens.cacheReadTokens,
    cacheCreation: tokens.cacheCreationTokens,
    thinking: 0,
  };
}

function totalTokens(tokens: ModelTokens): number {
  return (
    tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheCreationTokens
  );
}

/** Estimate energy, carbon and water for each model's tokens. Models without a price are counted, not guessed. */
export function estimateClimate(
  byModel: Readonly<Record<string, ModelTokens>>,
  prices: PriceTable = DEFAULT_PRICES,
  assumptions: ClimateAssumptions = DEFAULT_ASSUMPTIONS,
): ClimateEstimate {
  const models: ModelClimate[] = [];
  let unpricedTokens = 0;
  for (const [model, tokens] of Object.entries(byModel)) {
    const cost = estimateCost(model, toUsage(tokens), prices);
    if (cost === null) {
      unpricedTokens += totalTokens(tokens);
      continue;
    }
    const energyKwh = (cost * assumptions.whPerListDollar) / 1000;
    models.push({
      model,
      tokens: totalTokens(tokens),
      energyKwh,
      co2eKg: energyKwh * assumptions.kgCo2ePerKwh,
    });
  }
  const energyKwh = models.reduce((sum, row) => sum + row.energyKwh, 0);
  const carbonKg = energyKwh * assumptions.kgCo2ePerKwh;
  return {
    energyKwh,
    co2eKg: carbonKg,
    waterLiters: energyKwh * assumptions.litersPerKwh,
    drivingMiles: carbonKg / assumptions.kgCo2ePerMile,
    homeDays: energyKwh / assumptions.kwhPerHomeDay,
    unpricedTokens,
    models: models.toSorted((a, b) => b.energyKwh - a.energyKwh || a.model.localeCompare(b.model)),
    assumptions,
  };
}
