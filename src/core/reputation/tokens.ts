// How hard you run Claude: the average tokens a day over the last
// TOKEN_WINDOW_DAYS days, from the daily totals in Claude Code's usage stats.
// Someone newer than the window is averaged over the days since their first.

import type { DailyUsage } from '../../shared/model.js';
import { TOKEN_WINDOW_DAYS } from '../../shared/reputation.js';

import { dayOf } from './summarize.js';

const DAY_MS = 86_400_000;

/** Noon on a YYYY-MM-DD local date, so a daylight saving change never moves it a day. */
function noonOf(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 12).getTime();
}

function tokensOf(day: DailyUsage): number {
  return Object.values(day.tokensByModel).reduce((sum, tokens) => sum + tokens, 0);
}

/** Whole tokens a day, or 0 with no history. `days` is sorted oldest first, as the usage view keeps it. */
export function averageTokensPerDay(days: readonly DailyUsage[], now: number): number {
  const first = days[0]?.date;
  if (first === undefined) {
    return 0;
  }
  const today = noonOf(dayOf(now));
  const start = Math.max(noonOf(first), today - (TOKEN_WINDOW_DAYS - 1) * DAY_MS);
  if (start > today) {
    return 0;
  }
  const span = Math.round((today - start) / DAY_MS) + 1;
  const [from, to] = [dayOf(start), dayOf(today)];
  const tokens = days
    .filter((day) => day.date >= from && day.date <= to)
    .reduce((sum, day) => sum + tokensOf(day), 0);
  return Math.round(tokens / span);
}
