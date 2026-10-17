// A rough cost estimate shown before a batch starts, since budgets are off by
// default. It counts prompt characters plus a fixed overhead for the system
// prompt and tools, and assumes a fixed reply size. Each run is priced by its
// own agent's models facet, so a run of an agent with no prices is unknown.

import type { AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';
import type { ModelPrice } from '../transcripts/pricing.js';

/** What a run's agent charges, from its models facet. */
export interface AgentPrices {
  /** Null when the agent has no price for the model. */
  readonly price: (model: string) => ModelPrice | null;
  /** The model a run uses when its profile names none. */
  readonly defaultModel: string;
}

export interface EstimateOptions {
  /** The prices of a run's agent, which is Claude Code for a run with no profile. */
  readonly pricesFor: (agent: AgentId) => AgentPrices;
  /** System prompt, tools and CLAUDE.md, sent with every request. */
  readonly overheadTokens?: number;
  readonly outputTokens?: number;
  /** Model requests per run. */
  readonly requests?: number;
}

interface SpecEstimate {
  readonly label: string;
  readonly agent: AgentId;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Null when the agent has no price for the model, so the cost is unknown. */
  readonly usd: number | null;
}

export interface BatchEstimate {
  readonly runs: readonly SpecEstimate[];
  /** Sum over priced runs. */
  readonly totalUsd: number;
  /** How many runs have no price, so the total leaves them out. */
  readonly unpricedRuns: number;
  readonly unpricedModels: readonly string[];
}

export const DEFAULT_OVERHEAD_TOKENS = 15_000;
export const DEFAULT_OUTPUT_TOKENS = 2000;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
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
    const agent = profile?.agent ?? CLAUDE_CODE;
    const prices = options.pricesFor(agent);
    const model = profile?.model ?? prices.defaultModel;
    const inputTokens = (estimateTokens(spec.prompt) + overhead) * requests;
    const price = prices.price(model);
    if (price === null) {
      unpriced.add(model);
    }
    const usd =
      price === null ? null : (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
    return { label: spec.label, agent, model, inputTokens, outputTokens, usd };
  });
  const totalUsd = runs.reduce((total, run) => total + (run.usd ?? 0), 0);
  const unpricedRuns = runs.filter((run) => run.usd === null).length;
  return { runs, totalUsd, unpricedRuns, unpricedModels: [...unpriced] };
}
