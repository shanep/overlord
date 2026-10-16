// The launcher's cost estimate takes its own price shape, so the transcript
// price list is converted once, with the CLI's model aliases added so a
// profile that says "opus" still gets a price.

import type { PriceTable as EstimatePrices } from '../harness/estimate.js';
import type { PriceTable } from '../transcripts/pricing.js';

/** What the CLI uses when neither the profile nor settings pick a model. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Alias to the model id it stands for today. */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};

export function toEstimatePrices(prices: PriceTable): EstimatePrices {
  const table: Record<string, EstimatePrices[string]> = {};
  for (const [model, price] of Object.entries(prices)) {
    table[model] = { inputPerMTok: price.input, outputPerMTok: price.output };
  }
  for (const [alias, model] of Object.entries(MODEL_ALIASES)) {
    const price = table[model];
    if (price !== undefined) {
      table[alias] = price;
    }
  }
  return table;
}

/** "$0.42" style, two decimals. */
export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
