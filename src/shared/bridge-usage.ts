// Calls through the boisestate.ai bridge, as the Usage view shows them. The
// sidecar logs each one with the backend's own token counts.

/** Calls through the boisestate.ai bridge, by the backend's own token counts. */
export interface BridgeUsageTotals {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface BridgeUsageDay extends BridgeUsageTotals {
  /** Local calendar day, YYYY-MM-DD. */
  readonly date: string;
}

export interface BridgeUsageModel extends BridgeUsageTotals {
  /** The backend's model id, such as global.anthropic.claude-opus-5-5. */
  readonly model: string;
}

export interface BridgeUsage {
  /** Oldest first. */
  readonly days: readonly BridgeUsageDay[];
  /** Most tokens first. */
  readonly models: readonly BridgeUsageModel[];
}
