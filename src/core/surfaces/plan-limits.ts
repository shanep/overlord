// Plan limits (the current session and weekly windows that /usage shows), from
// the Agent SDK's experimental get_usage control call. The reply mirrors the
// claude.ai usage endpoint and may change, so every field falls back on its
// own and a reply with nothing usable reads as no plan.

import { z } from 'zod';

import type { PlanLimit, PlanLimits } from '../../shared/protocol.js';

import { lenientArray } from './common.js';

const labelSchema = z.object({ display_name: z.string() }).nullish().catch(null);

const rowSchema = z.object({
  kind: z.string(),
  percent: z.number(),
  resets_at: z.string().nullish().catch(null),
  severity: z.string().catch('normal'),
  scope: z.object({ model: labelSchema, surface: labelSchema }).nullish().catch(null),
});

const windowSchema = z
  .object({
    utilization: z.number().nullish().catch(null),
    resets_at: z.string().nullish().catch(null),
  })
  .nullish()
  .catch(null);

const modelWindowSchema = z.object({
  display_name: z.string(),
  utilization: z.number().nullish().catch(null),
  resets_at: z.string().nullish().catch(null),
});

const extraSchema = z
  .object({ is_enabled: z.boolean(), utilization: z.number().nullish().catch(null) })
  .nullish()
  .catch(null);

const replySchema = z.object({
  subscription_type: z.string().nullish().catch(null),
  rate_limits_available: z.boolean().catch(false),
  rate_limits: z
    .object({
      // The server's own rows, in display order. Null from older servers.
      limits: z.array(z.unknown()).nullish().catch(null),
      five_hour: windowSchema,
      seven_day: windowSchema,
      seven_day_opus: windowSchema,
      seven_day_sonnet: windowSchema,
      model_scoped: lenientArray(modelWindowSchema).nullish(),
      extra_usage: extraSchema,
    })
    .nullish()
    .catch(null),
});

type Reply = z.infer<typeof replySchema>;
type Row = z.infer<typeof rowSchema>;
type RateLimits = NonNullable<Reply['rate_limits']>;

function toEpochMs(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function rowLabel(row: Row): string {
  switch (row.kind) {
    case 'session': {
      return 'Current session';
    }
    case 'weekly_all': {
      return 'Current week (all models)';
    }
    case 'weekly_scoped': {
      const scope = row.scope?.model?.display_name ?? row.scope?.surface?.display_name;
      return scope === undefined ? 'Current week' : `Current week (${scope})`;
    }
    default: {
      const words = row.kind.replaceAll('_', ' ');
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

function fromRows(rows: readonly unknown[]): PlanLimit[] {
  return lenientArray(rowSchema)
    .parse(rows)
    .map((row) => ({
      kind: row.kind,
      label: rowLabel(row),
      percent: clampPercent(row.percent),
      resetsAt: toEpochMs(row.resets_at),
      severity: row.severity,
    }));
}

/** The server grades its own rows; for the named windows, grade like /usage does. */
function severityOf(percent: number): string {
  if (percent >= 90) {
    return 'critical';
  }
  return percent >= 70 ? 'warning' : 'normal';
}

interface TimedWindow {
  readonly utilization?: number | null | undefined;
  readonly resets_at?: string | null | undefined;
}

function windowLimit(
  kind: string,
  label: string,
  window: TimedWindow | null | undefined,
): PlanLimit[] {
  const utilization = window?.utilization;
  if (utilization === null || utilization === undefined) {
    return [];
  }
  const percent = clampPercent(utilization);
  return [
    {
      kind,
      label,
      percent,
      resetsAt: toEpochMs(window?.resets_at),
      severity: severityOf(percent),
    },
  ];
}

/** For servers that predate limits[]: build the rows from the named windows. */
function fromWindows(limits: RateLimits): PlanLimit[] {
  const models =
    limits.model_scoped ??
    [
      { display_name: 'Opus', ...limits.seven_day_opus },
      { display_name: 'Sonnet', ...limits.seven_day_sonnet },
    ].filter((model) => model.utilization !== undefined);
  return [
    ...windowLimit('session', 'Current session', limits.five_hour),
    ...windowLimit('weekly_all', 'Current week (all models)', limits.seven_day),
    ...models.flatMap((model) =>
      windowLimit('weekly_scoped', `Current week (${model.display_name})`, model),
    ),
  ];
}

function extraUsage(limits: RateLimits): PlanLimit[] {
  const extra = limits.extra_usage;
  if (extra?.is_enabled !== true) {
    return [];
  }
  return windowLimit('extra_usage', 'Extra usage this month', extra);
}

/** Turn a get_usage reply into plan limits. Null when plan limits do not apply. */
export function parsePlanUsage(json: unknown, now: number): PlanLimits | null {
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const reply = parsed.data;
  const limits = reply.rate_limits;
  if (!reply.rate_limits_available || limits === null || limits === undefined) {
    return null;
  }
  const rows = limits.limits;
  return {
    subscription: reply.subscription_type ?? null,
    limits: [
      ...(rows === null || rows === undefined ? fromWindows(limits) : fromRows(rows)),
      ...extraUsage(limits),
    ],
    fetchedAt: now,
  };
}
