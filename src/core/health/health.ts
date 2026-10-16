// Session health: reads the main thread's requests, tool calls and
// compactions for signs that the session is starting to work worse, and says
// what to do about each one.

import type {
  HealthLevel,
  HealthMetrics,
  HealthSignal,
  SessionHealth,
} from '../../shared/health.js';
import type { ApiRequest, ToolCall } from '../../shared/model.js';
import { contextWindow, promptTokens } from '../../shared/model.js';
import { percent, plural, tokens } from '../tuning/words.js';

/** What the main thread did, for one session. */
export interface HealthInput {
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly requests: readonly ApiRequest[];
  readonly toolCalls: readonly ToolCall[];
  /** Compaction times. */
  readonly compactions: readonly number[];
}

type Level = HealthSignal['level'];

// Quality drops with the size of the context, not just how close it is to the
// limit, so a 1M window gets flagged long before it fills. The system prompt
// and tools alone are often 40K or more, so the bar sits well above that.
const CONTEXT_WATCH_TOKENS = 300_000;
const CONTEXT_DEGRADED_TOKENS = 500_000;
const FILL_WATCH = 0.6;
const FILL_DEGRADED = 0.8;

const RECENT_CALLS = 20;
const ERRORS_WATCH = 4;
const ERRORS_DEGRADED = 8;

const CACHE_TURNS = 10;
const CACHE_MIN_TURNS = 5;
const CACHE_WATCH = 0.5;
/** Below this many prompt tokens a turn, a cache miss costs too little to mention. */
const CACHE_MIN_PROMPT = 20_000;

const HOUR_MS = 60 * 60 * 1000;
const AGE_WATCH_MS = 8 * HOUR_MS;

const RANK: Readonly<Record<HealthLevel, number>> = { good: 0, watch: 1, degraded: 2 };

function contextLevel(used: number, window: number): Level | null {
  const fill = used / window;
  if (used >= CONTEXT_DEGRADED_TOKENS || fill >= FILL_DEGRADED) {
    return 'degraded';
  }
  return used >= CONTEXT_WATCH_TOKENS || fill >= FILL_WATCH ? 'watch' : null;
}

function contextSignal(used: number, window: number): HealthSignal | null {
  const level = contextLevel(used, window);
  if (level === null) {
    return null;
  }
  const fill = used / window;
  const soon =
    fill >= FILL_DEGRADED
      ? ' Claude Code compacts on its own soon, and then it picks what to keep, not you.'
      : '';
  return {
    id: 'context',
    level,
    title: level === 'degraded' ? 'The context is very large' : 'The context is getting large',
    finding: `${tokens(used)} tokens in context, ${percent(fill)} of a ${tokens(window)} window.`,
    why: `The bigger the context, the more likely the model misses instructions from early on and loses track of what was decided. Every turn also costs more and starts slower.${soon}`,
    actions: [
      'Run /compact with what to keep, for example /compact keep the plan, the open questions and the failing test names.',
      'If the next piece of work is a new task, ask for a short handoff note, run /clear and paste the note in.',
      'Hand big searches and file reads to a subagent so their output stays out of this context.',
    ],
  };
}

function compactionSignal(count: number): HealthSignal | null {
  if (count === 0) {
    return null;
  }
  return {
    id: 'compactions',
    level: count >= 2 ? 'degraded' : 'watch',
    title: count >= 2 ? 'Compacted more than once' : 'Compacted once',
    finding: `Compacted ${plural(count, 'time')}.`,
    why: 'Each compaction swaps the conversation for a summary. Exact error text, file paths and the reasons behind decisions can drop out, and the model does not know what it lost.',
    actions: [
      'Ask it to restate the goal, the plan and what is left, and correct anything it got wrong.',
      'Start fresh: ask for a handoff note, run /clear and paste the note in.',
      'Put facts it keeps losing in CLAUDE.md or a notes file so they survive the next compaction.',
    ],
  };
}

/** The tool that failed most, so the finding can name it. */
function worstTool(failed: readonly ToolCall[]): { readonly name: string; readonly count: number } {
  const counts = new Map<string, number>();
  let worst = { name: '', count: 0 };
  for (const call of failed) {
    const count = (counts.get(call.name) ?? 0) + 1;
    counts.set(call.name, count);
    if (count > worst.count) {
      worst = { name: call.name, count };
    }
  }
  return worst;
}

function toolErrorSignal(recent: readonly ToolCall[]): HealthSignal | null {
  const failed = recent.filter((call) => call.ok === false);
  if (failed.length < ERRORS_WATCH) {
    return null;
  }
  const worst = worstTool(failed);
  return {
    id: 'tool-errors',
    level: failed.length >= ERRORS_DEGRADED ? 'degraded' : 'watch',
    title: 'Tool calls keep failing',
    finding: `${failed.length.toString()} of the last ${plural(recent.length, 'tool call')} failed, ${worst.count.toString()} of them ${worst.name}.`,
    why: 'A run of failures usually means it is stuck on the same approach, and every failed attempt adds noise to the context.',
    actions: [
      'Press Esc and tell it what is wrong, or give it what it is missing (a path, a command, a permission).',
      'Ask it to stop and list what it has tried before it tries again.',
      'Run /rewind (or press Esc twice) to go back to before the failures and steer it another way.',
    ],
  };
}

/** Cache hit share over the latest turns, or null when there is nothing to judge. */
function recentCacheHit(recent: readonly ApiRequest[]): number | null {
  const prompt = recent.reduce((sum, request) => sum + promptTokens(request.usage), 0);
  if (prompt === 0) {
    return null;
  }
  return recent.reduce((sum, request) => sum + request.usage.cacheRead, 0) / prompt;
}

function cacheSignal(
  recent: readonly ApiRequest[],
  hit: number | null,
  compactions: readonly number[],
): HealthSignal | null {
  // A compaction rebuilds the prompt, so misses right after one are expected.
  const since = recent[0]?.timestamp ?? 0;
  if (
    hit === null ||
    hit >= CACHE_WATCH ||
    recent.length < CACHE_MIN_TURNS ||
    compactions.some((at) => at >= since)
  ) {
    return null;
  }
  const prompt = recent.reduce((sum, request) => sum + promptTokens(request.usage), 0);
  if (prompt / recent.length < CACHE_MIN_PROMPT) {
    return null;
  }
  return {
    id: 'cache',
    level: 'watch',
    title: 'The prompt cache keeps missing',
    finding: `Only ${percent(hit)} of the prompt came from the cache over the last ${plural(recent.length, 'turn')}.`,
    why: 'A miss means the whole context is read again at full price, so turns cost more and start slower. It happens after a pause longer than the cache lasts, or when the model, tools or system prompt change mid session.',
    actions: [
      'After a long break on a big session, a fresh session with a handoff note is often cheaper than picking this one back up.',
      'Avoid switching models or turning MCP servers on and off in the middle of a session.',
    ],
  };
}

function ageWords(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  return hours >= 48 ? plural(Math.floor(hours / 24), 'day') : plural(hours, 'hour');
}

function ageSignal(startedAt: number, updatedAt: number): HealthSignal | null {
  const age = updatedAt - startedAt;
  if (age < AGE_WATCH_MS) {
    return null;
  }
  return {
    id: 'age',
    level: 'watch',
    title: 'A long running session',
    finding: `Active over ${ageWords(age)}, from its first turn to its latest.`,
    why: 'Files, branches and plans change while a session stays open, and it still believes what it read hours ago.',
    actions: [
      'Ask it to read the files again before it edits them.',
      'If the work has moved on, start a new session for the next task.',
    ],
  };
}

function byTime<T>(items: readonly T[], at: (item: T) => number): readonly T[] {
  return items.toSorted((left, right) => at(left) - at(right));
}

export function assessHealth(input: HealthInput): SessionHealth {
  const requests = byTime(input.requests, (request) => request.timestamp);
  const recentCalls = byTime(
    input.toolCalls.filter((call) => call.ok !== null),
    (call) => call.startedAt,
  ).slice(-RECENT_CALLS);
  const recentRequests = requests.slice(-CACHE_TURNS);
  const latest = requests.at(-1);
  const used = latest === undefined ? null : promptTokens(latest.usage);
  const window =
    latest === undefined ? null : contextWindow(latest.model, promptTokens(latest.usage));
  const hit = recentCacheHit(recentRequests);
  const metrics: HealthMetrics = {
    contextTokens: used,
    contextWindow: window,
    compactions: input.compactions.length,
    turns: requests.length,
    recentToolErrors: recentCalls.filter((call) => call.ok === false).length,
    recentToolCalls: recentCalls.length,
    recentCacheHit: hit,
  };
  const signals = [
    used === null || window === null ? null : contextSignal(used, window),
    compactionSignal(input.compactions.length),
    toolErrorSignal(recentCalls),
    cacheSignal(recentRequests, hit, input.compactions),
    ageSignal(input.startedAt, input.updatedAt),
  ]
    .filter((signal) => signal !== null)
    .toSorted((left, right) => RANK[right.level] - RANK[left.level]);
  const worst = signals[0]?.level ?? 'good';
  return { level: worst, metrics, signals };
}
