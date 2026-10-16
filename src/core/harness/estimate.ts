// A rough cost estimate shown before a batch starts, since budgets are off by
// default. It counts prompt characters plus a fixed overhead for the system
// prompt and tools, and assumes a fixed reply size. The price table comes from
// the caller.

import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';

export interface ModelPrice {
  /** USD per million input tokens. */
  readonly inputPerMTok: number;
  /** USD per million output tokens. */
  readonly outputPerMTok: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

export interface EstimateOptions {
  readonly prices: PriceTable;
  /** The model a run uses when its profile names none. */
  readonly defaultModel: string;
  /** System prompt, tools and CLAUDE.md, sent with every request. */
  readonly overheadTokens?: number;
  readonly outputTokens?: number;
  /** Model requests per run. */
  readonly requests?: number;
}

interface SpecEstimate {
  readonly label: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Null when the model has no price. */
  readonly usd: number | null;
}

export interface BatchEstimate {
  readonly runs: readonly SpecEstimate[];
  /** Sum over priced runs. */
  readonly totalUsd: number;
  readonly unpricedModels: readonly string[];
}

export const DEFAULT_OVERHEAD_TOKENS = 15_000;
export const DEFAULT_OUTPUT_TOKENS = 2000;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Exact match first, then the longest key the model id starts with (for suffixes like [1m]). */
export function findPrice(prices: PriceTable, model: string): ModelPrice | null {
  const exact = prices[model];
  if (exact !== undefined) {
    return exact;
  }
  let best: { readonly key: string; readonly price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(prices)) {
    if (model.startsWith(key) && (best === null || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price ?? null;
}

export function estimateBatch(
  specs: readonly LaunchSpec[],
  profiles: readonly LaunchProfile[],
  options: EstimateOptions,
): BatchEstimate {
  const requests = options.requests ?? 1;
  const overhead = options.overheadTokens ?? DEFAULT_OVERHEAD_TOKENS;
  const outputTokens = (options.outputTokens ?? DEFAULT_OUTPUT_TOKENS) * requests;
  const unpriced = new Set<string>();
  const runs = specs.map((spec): SpecEstimate => {
    const profile = profiles.find((candidate) => candidate.id === spec.profileId);
    const model = profile?.model ?? options.defaultModel;
    const inputTokens = (estimateTokens(spec.prompt) + overhead) * requests;
    const price = findPrice(options.prices, model);
    if (price === null) {
      unpriced.add(model);
    }
    const usd =
      price === null
        ? null
        : (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
    return { label: spec.label, model, inputTokens, outputTokens, usd };
  });
  const totalUsd = runs.reduce((total, run) => total + (run.usd ?? 0), 0);
  return { runs, totalUsd, unpricedModels: [...unpriced] };
}
