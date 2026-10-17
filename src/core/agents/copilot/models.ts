// What Copilot's own files say about models, cost and the format version.
// Copilot reports what each call cost in nano AI units (nano-AIU), so the
// dollars come from that and not from a price table.
// cspell:words Aiu

/** Copilot CLI versions whose events.jsonl the parser was checked against. */
const TESTED_VERSIONS: ReadonlySet<string> = new Set(['1.0.89']);

/**
 * True when sessions from this Copilot version were written in a format the
 * parser was tested on. Outside that list the numbers may be wrong, and the
 * UI should say "format not verified" (the rule PLAN.md sets for Claude files).
 * @public
 */
export function formatVerified(version: string | null): boolean {
  return version !== null && TESTED_VERSIONS.has(version);
}

// Context windows the recorded data reported: ACP usage_update gives `size`
// and the ephemeral session.usage_info gives `tokenLimit`. A window seen in a
// session's own events wins over this table.
const WINDOWS: Readonly<Record<string, number>> = {
  'gpt-5-mini': 128_000,
};

/** The context window for a Copilot model id, or null when no data has named it. */
export function copilotContextWindow(model: string | null, observedTokens = 0): number | null {
  const known = model === null ? undefined : WINDOWS[model];
  if (known === undefined) {
    return null;
  }
  return Math.max(known, observedTokens);
}

/**
 * How full a session's context is. session.shutdown and the ephemeral
 * session.usage_info say how many tokens it holds, and usage_info also names
 * the window.
 */
export class ContextGauge {
  private tokens: number | null = null;
  private model: string | null = null;
  private limit: number | null = null;

  /** What session.shutdown reports. */
  closed(tokens: number | null | undefined, model: string | null | undefined): void {
    this.tokens = tokens ?? this.tokens;
    this.model = model ?? this.model;
  }

  /** What session.usage_info reports. */
  measured(tokens: number, limit: number): void {
    this.tokens = tokens;
    this.limit = limit > 0 ? limit : this.limit;
  }

  /** 0 to 1, or null when the tokens or the window are unknown. */
  fill(sessionModel: string | null): number | null {
    const tokens = this.tokens;
    if (tokens === null) {
      return null;
    }
    const window = this.limit ?? copilotContextWindow(this.model ?? sessionModel, tokens);
    return window === null || window === 0 ? null : tokens / window;
  }
}

// GitHub bills Copilot in AI credits at $0.01 each, and events count them in
// billionths (nano-AIU).
const USD_PER_NANO_AIU = 0.01 / 1e9;

export function nanoAiuToUsd(nanoAiu: number): number {
  return nanoAiu * USD_PER_NANO_AIU;
}

/** Copilot picks a model itself when none is set. */
export const COPILOT_DEFAULT_MODEL = 'auto';
