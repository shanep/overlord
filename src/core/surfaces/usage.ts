// Usage history from ~/.claude/stats-cache.json. Undocumented; tested against
// version 5 of the file (Claude Code 2.1.301). Claude Code recomputes it now
// and then, so it can trail today by a day.

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { DailyUsage } from '../../shared/model.js';
import type { UsageStats } from '../../shared/protocol.js';
import type { ClaudePaths } from '../paths.js';

import { hasErrorCode, lenientArray, sourceError } from './common.js';
import type { SourceError } from './common.js';

const count = z.number().nonnegative().catch(0);

const activitySchema = z.object({
  date: z.string(),
  messageCount: count,
  sessionCount: count,
  toolCallCount: count,
});

const modelTokensSchema = z.object({
  date: z.string(),
  tokensByModel: z.record(z.string(), count).catch({}),
});

const modelUsageSchema = z.object({
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count,
  cacheCreationInputTokens: count,
  webSearchRequests: count,
  costUSD: count,
});

const longestSchema = z.object({
  sessionId: z.string(),
  timestamp: z.string().nullish(),
  duration: count,
  messageCount: count,
});

// Each field falls back on its own so one odd field does not drop the rest.
const statsSchema = z.object({
  version: z.number().nullish().catch(null),
  lastComputedDate: z.string().nullish().catch(null),
  firstSessionDate: z.string().nullish().catch(null),
  dailyActivity: lenientArray(activitySchema),
  dailyModelTokens: lenientArray(modelTokensSchema),
  hourCounts: z.record(z.string(), count).catch({}),
  modelUsage: z.record(z.string(), modelUsageSchema).catch({}),
  totalSessions: count,
  totalMessages: count,
  longestSession: longestSchema.nullish().catch(null),
});

interface ModelUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly webSearchRequests: number;
  readonly costUsd: number;
}

interface LongestSession {
  readonly sessionId: string;
  readonly at: string | null;
  readonly durationMs: number;
  readonly messages: number;
}

export interface UsageHistory {
  readonly usage: UsageStats;
  readonly modelUsage: Readonly<Record<string, ModelUsageTotals>>;
  readonly longestSession: LongestSession | null;
  readonly firstSessionDate: string | null;
  readonly lastComputedDate: string | null;
  readonly formatVersion: number | null;
}

export interface UsageRead {
  /** Null when the file is missing or unreadable. */
  readonly history: UsageHistory | null;
  readonly errors: readonly SourceError[];
}

export const EMPTY_USAGE: UsageStats = {
  days: [],
  hourCounts: {},
  totalSessions: 0,
  totalMessages: 0,
};

type Stats = z.infer<typeof statsSchema>;

function buildDays(stats: Stats): DailyUsage[] {
  const byDate = new Map<string, DailyUsage>();
  const blank = (date: string): DailyUsage => ({
    date,
    messages: 0,
    sessions: 0,
    toolCalls: 0,
    tokensByModel: {},
  });
  for (const day of stats.dailyActivity) {
    byDate.set(day.date, {
      ...blank(day.date),
      messages: day.messageCount,
      sessions: day.sessionCount,
      toolCalls: day.toolCallCount,
    });
  }
  for (const day of stats.dailyModelTokens) {
    const base = byDate.get(day.date) ?? blank(day.date);
    byDate.set(day.date, { ...base, tokensByModel: day.tokensByModel });
  }
  return [...byDate.values()].toSorted((a, b) => a.date.localeCompare(b.date));
}

function buildModelUsage(stats: Stats): Record<string, ModelUsageTotals> {
  const out: Record<string, ModelUsageTotals> = {};
  for (const [model, usage] of Object.entries(stats.modelUsage)) {
    out[model] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheCreationTokens: usage.cacheCreationInputTokens,
      webSearchRequests: usage.webSearchRequests,
      costUsd: usage.costUSD,
    };
  }
  return out;
}

function toLongest(raw: Stats['longestSession']): LongestSession | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  return {
    sessionId: raw.sessionId,
    at: raw.timestamp ?? null,
    durationMs: raw.duration,
    messages: raw.messageCount,
  };
}

/** Turn parsed stats-cache JSON into usage history. Throws when it is not an object. */
export function parseStatsCache(json: unknown): UsageHistory {
  const parsed = statsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('stats-cache.json is not an object');
  }
  const stats = parsed.data;
  return {
    usage: {
      days: buildDays(stats),
      hourCounts: stats.hourCounts,
      totalSessions: stats.totalSessions,
      totalMessages: stats.totalMessages,
    },
    modelUsage: buildModelUsage(stats),
    longestSession: toLongest(stats.longestSession),
    firstSessionDate: stats.firstSessionDate ?? null,
    lastComputedDate: stats.lastComputedDate ?? null,
    formatVersion: stats.version ?? null,
  };
}

/** Read stats-cache.json. A missing file is not an error, just no history yet. */
export async function readUsageHistory(paths: ClaudePaths): Promise<UsageRead> {
  try {
    const text = await readFile(paths.statsCache, 'utf8');
    const json: unknown = JSON.parse(text);
    return { history: parseStatsCache(json), errors: [] };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { history: null, errors: [] };
    }
    return { history: null, errors: [sourceError('stats-cache', error, paths.statsCache)] };
  }
}
