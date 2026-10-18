// The Usage view's state: usage history, the climate estimate and plan limits.

import type { RateLimitWindow } from './agents.js';
import type { BridgeUsage } from './bridge-usage.js';
import type { DailyUsage } from './model.js';

export interface UsageStats {
  readonly days: readonly DailyUsage[];
  readonly hourCounts: Readonly<Record<string, number>>;
  readonly totalSessions: number;
  readonly totalMessages: number;
  readonly climate: ClimateEstimate;
  /** Calls through the boisestate.ai bridge. Absent until the sidecar has logged one. */
  readonly bridge?: BridgeUsage;
}

/** The numbers behind the climate estimate, so the view can show its working. */
export interface ClimateAssumptions {
  readonly whPerListDollar: number;
  readonly kgCo2ePerKwh: number;
  readonly litersPerKwh: number;
  readonly kgCo2ePerMile: number;
  readonly kwhPerHomeDay: number;
}

/** One model's share of the climate estimate. */
export interface ModelClimate {
  readonly model: string;
  readonly tokens: number;
  readonly energyKwh: number;
  readonly co2eKg: number;
}

/** A rough estimate of the energy, carbon and water behind the usage history. */
export interface ClimateEstimate {
  readonly energyKwh: number;
  readonly co2eKg: number;
  readonly waterLiters: number;
  /** Miles in an average gas car with the same CO2e. */
  readonly drivingMiles: number;
  /** Days of an average US home's electricity. */
  readonly homeDays: number;
  /** Tokens from models with no list price, left out of the totals. */
  readonly unpricedTokens: number;
  /** Largest energy first. */
  readonly models: readonly ModelClimate[];
  readonly assumptions: ClimateAssumptions;
}

/** One plan limit window, such as the current session or the current week. */
export interface PlanLimit {
  /** The server's meter kind, for example "session", "weekly_all" or "weekly_scoped". */
  readonly kind: string;
  readonly label: string;
  /** Share of the window used, 0 to 100. */
  readonly percent: number;
  /** Epoch ms when the window resets, or null when unknown. */
  readonly resetsAt: number | null;
  /** The server's grading of the meter: "normal", "warning" or "critical". */
  readonly severity: string;
}

/** The claude.ai plan limits that /usage shows. */
export interface PlanLimits {
  /** "pro", "max", "team" or "enterprise", or null when unknown. */
  readonly subscription: string | null;
  readonly limits: readonly PlanLimit[];
  /** Epoch ms of the read. */
  readonly fetchedAt: number;
}

export interface UsageState extends UsageStats {
  /** Null when plan limits do not apply (API key, Bedrock, Vertex) or could not be read. */
  readonly plan: PlanLimits | null;
  /** Usage limit windows the agents' sessions reported. Left out before the first one. */
  readonly windows?: readonly RateLimitWindow[];
}
