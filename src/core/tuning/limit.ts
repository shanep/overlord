// How the plan's usage limits are being used. The plan limits say how full the
// session and weekly windows are; the hourly spend in the measures says which
// sessions filled the current window and what habits would have saved over
// the last week. Spend at list price stands in for usage, since the limits
// count tokens weighted by model in much the same way.

import type { PlanLimit, PlanLimits } from '../../shared/protocol.js';
import type { LimitLever, LimitSession, LimitState, LimitWindow } from '../../shared/tuning.js';

import type { SessionMeasure } from './measure.js';
import type { SpendHour } from './spend-hours.js';
import { CONTEXT_BUDGET, HOUR_MS } from './spend-hours.js';
import { percent, tokens, usd } from './words.js';

export const SESSION_WINDOW_MS = 5 * HOUR_MS;
export const WEEK_MS = 7 * 24 * HOUR_MS;
const WINDOW_LENGTHS: Readonly<Record<string, number>> = {
  session: SESSION_WINDOW_MS,
  weekly_all: WEEK_MS,
};
const MAX_SESSIONS = 8;
/** A lever that would save less than this share of the week is not worth showing. */
const MIN_SAVING = 0.02;

/** When the window fills at the pace so far, or null when it lasts until the reset. */
export function runsOutAt(limit: PlanLimit, startsAt: number | null, at: number): number | null {
  if (startsAt === null || limit.resetsAt === null || limit.percent <= 0 || limit.percent >= 100) {
    return null;
  }
  const elapsed = at - startsAt;
  if (elapsed <= 0) {
    return null;
  }
  const out = at + ((100 - limit.percent) * elapsed) / limit.percent;
  return out < limit.resetsAt ? out : null;
}

function windowOf(limit: PlanLimit, at: number): LimitWindow | null {
  const length = WINDOW_LENGTHS[limit.kind];
  if (length === undefined) {
    return null;
  }
  const startsAt = limit.resetsAt === null ? null : limit.resetsAt - length;
  return {
    kind: limit.kind,
    label: limit.label,
    percent: limit.percent,
    severity: limit.severity,
    startsAt,
    resetsAt: limit.resetsAt,
    runsOutAt: runsOutAt(limit, startsAt, at),
  };
}

/** The hours that start at or after `from`, counting the hour `from` falls in. */
function hoursSince(measure: SessionMeasure, from: number): readonly SpendHour[] {
  const first = Math.floor(from / HOUR_MS) * HOUR_MS;
  return measure.hours.filter((hour) => hour.at >= first);
}

type HourField = Exclude<keyof SpendHour, 'at'>;

function sumHours(hours: readonly SpendHour[], field: HourField): number {
  return hours.reduce((total, hour) => total + hour[field], 0);
}

function windowSessions(
  measures: readonly SessionMeasure[],
  from: number,
): { readonly usd: number; readonly sessions: LimitSession[] } {
  const spent = measures
    .map((measure) => ({ measure, usd: sumHours(hoursSince(measure, from), 'usd') }))
    .filter((item) => item.usd > 0);
  const total = spent.reduce((sum, item) => sum + item.usd, 0);
  const sessions = spent
    .toSorted((left, right) => right.usd - left.usd)
    .slice(0, MAX_SESSIONS)
    .map(({ measure, usd: spend }) => ({
      sessionId: measure.sessionId,
      title: measure.title,
      usd: spend,
      share: spend / total,
    }));
  return { usd: total, sessions };
}

type WeekTotals = Readonly<Record<HourField, number>>;

function weekTotals(measures: readonly SessionMeasure[], from: number): WeekTotals {
  const hours = measures.flatMap((measure) => hoursSince(measure, from));
  return {
    usd: sumHours(hours, 'usd'),
    subagentUsd: sumHours(hours, 'subagentUsd'),
    premiumUsd: sumHours(hours, 'premiumUsd'),
    premiumSavingUsd: sumHours(hours, 'premiumSavingUsd'),
    subagentSavingUsd: sumHours(hours, 'subagentSavingUsd'),
    bigContextUsd: sumHours(hours, 'bigContextUsd'),
    idleRewriteUsd: sumHours(hours, 'idleRewriteUsd'),
  };
}

interface LeverDefinition {
  readonly id: string;
  readonly title: string;
  readonly saved: (week: WeekTotals) => number;
  readonly finding: (week: WeekTotals) => string;
  readonly advice: readonly string[];
  readonly tipId: string | null;
}

const LEVERS: readonly LeverDefinition[] = [
  {
    id: 'routine-model',
    title: 'Run routine work on Sonnet',
    saved: (week) => week.premiumSavingUsd,
    finding: (week) =>
      `${percent(week.premiumUsd / week.usd)} of the last week went to Opus, Fable or Mythos in main sessions.`,
    advice: [
      'Start routine sessions (small fixes, tests, docs, landing work) on Sonnet with /model sonnet.',
      'Use /model opusplan for bigger tasks: Opus plans, then Sonnet makes the edits.',
      'Keep Opus for design work and bugs Sonnet has already failed to fix.',
    ],
    tipId: null,
  },
  {
    id: 'subagent-model',
    title: 'Run subagents on a cheaper model',
    saved: (week) => week.subagentSavingUsd,
    finding: (week) =>
      `Subagents used ${percent(week.subagentUsd / week.usd)} of the last week, much of it on premium models.`,
    advice: [
      'Set CLAUDE_CODE_SUBAGENT_MODEL to sonnet in Knobs, or give your own agents model: sonnet.',
      'Searches and log reading do fine on haiku.',
    ],
    tipId: 'subagent-model',
  },
  {
    id: 'context',
    title: 'Keep context small',
    saved: (week) => week.bigContextUsd,
    finding: () =>
      `Every request sends the whole context again. Context past ${tokens(CONTEXT_BUDGET)} tokens is where this much went.`,
    advice: [
      'Use /clear between tasks, and write a handoff note first when the task goes on.',
      'Send broad searches and long logs to a subagent so only its answer lands in the main context.',
      'Lower the auto compact window so long sessions compact sooner.',
    ],
    tipId: 'huge-context',
  },
  {
    id: 'idle-rewrite',
    title: 'Start fresh after a break',
    saved: (week) => week.idleRewriteUsd,
    finding: () =>
      'The prompt cache expires after five minutes, so going back to a big session after a break writes its whole context again.',
    advice: [
      'After a break, /clear or start a new session instead of sending one more prompt to a big one.',
      'Wrap a long task up before you step away, so it does not need the old context back.',
    ],
    tipId: 'idle-rewrite',
  },
];

function leversOf(week: WeekTotals): LimitLever[] {
  if (week.usd <= 0) {
    return [];
  }
  return LEVERS.flatMap((lever) => {
    const savedUsd = lever.saved(week);
    const saving = savedUsd / week.usd;
    if (saving < MIN_SAVING) {
      return [];
    }
    return [
      {
        id: lever.id,
        title: lever.title,
        finding: `${lever.finding(week)} Changing this would have saved about ${usd(savedUsd)} of ${usd(week.usd)}.`,
        advice: lever.advice,
        savedUsd,
        saving,
        tipId: lever.tipId,
      },
    ];
  }).toSorted((left, right) => right.saving - left.saving);
}

export interface LimitInputs {
  readonly plan: PlanLimits | null;
  /** Live sessions and history, since the window and the week can reach back past a deleted transcript. */
  readonly measures: readonly SessionMeasure[];
  readonly now: number;
}

export function buildLimit(inputs: LimitInputs): LimitState {
  const { plan, measures, now } = inputs;
  // The percentages are as of the read, so the pace runs from then.
  const at = plan?.fetchedAt ?? now;
  const windows = (plan?.limits ?? []).flatMap((limit) => windowOf(limit, at) ?? []);
  const session = windows.find((window) => window.kind === 'session');
  const windowStart = session?.startsAt ?? now - SESSION_WINDOW_MS;
  const spent = windowSessions(measures, windowStart);
  const week = weekTotals(measures, now - WEEK_MS);
  return {
    subscription: plan?.subscription ?? null,
    windows,
    windowStart,
    windowUsd: spent.usd,
    sessions: spent.sessions,
    weekUsd: week.usd,
    levers: leversOf(week),
  };
}
