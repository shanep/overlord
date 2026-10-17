// Claude Code's default model and model aliases, so a profile that says
// "opus" still gets a price, and the dollar format the host uses.

/** What the CLI uses when neither the profile nor settings pick a model. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Alias to the model id it stands for today. */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};

/** "$0.42" style, two decimals. */
export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
