// Codex's models facet. Codex writes each turn's usable context window into
// the rollout (model_context_window), so the window is learned from there
// rather than kept in a table that goes stale with every new model.

import type { ModelFacet } from '../types.js';

/** What Codex 0.163.0 runs on a ChatGPT plan when config.toml sets no model. */
const CODEX_DEFAULT_MODEL = 'gpt-6-luna';

const windows = new Map<string, number>();

/** Notes the window a rollout reported for a model, for sessions that have not reported one yet. */
export function rememberWindow(model: string, tokens: number): void {
  if (tokens > 0) {
    windows.set(model, tokens);
  }
}

export const codexModels: ModelFacet = {
  contextWindow: (model, observedTokens = 0) => {
    const known = model === null ? undefined : windows.get(model);
    if (known === undefined) {
      return null;
    }
    // A prompt bigger than the window Codex reported means it has a larger one now.
    return Math.max(known, observedTokens);
  },
  price: () => null,
  defaultModel: CODEX_DEFAULT_MODEL,
};
