// The tips. Each rule looks at the totals to decide whether it applies at
// all, and at each session to list the ones that show the problem worst.
// Thresholds are set so a tip only shows when it is worth acting on.

import type { Tip, TipSession, TipSeverity } from '../../shared/protocol.js';

import type { SessionMeasure } from './measure.js';
import { costTotal } from './measure.js';
import type { Totals } from './totals.js';
import { LARGE_CONTEXT, LONG_SESSION_PROMPTS, sessionUsd } from './totals.js';
import { percent, plural, tokens, usd } from './words.js';

const SESSIONS_PER_TIP = 5;

export interface TipRule {
  readonly id: string;
  readonly severity: TipSeverity;
  readonly title: string;
  readonly advice: readonly string[];
  /** Suggestion ids that help. */
  readonly fixes: readonly string[];
  /** What the transcripts show, or null when the tip does not apply. */
  readonly finding: (totals: Totals) => string | null;
  /** True when this session shows the problem. */
  readonly flags: (measure: SessionMeasure) => boolean;
  /** How badly, for ordering. */
  readonly metric: (measure: SessionMeasure) => number;
  readonly detail: (measure: SessionMeasure) => string;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function failures(measure: SessionMeasure): number {
  return measure.toolErrors - measure.denials;
}

function exploreNote(totals: Totals): string {
  return totals.spawns < 10
    ? ''
    : ` Only ${totals.exploreSpawns.toLocaleString('en-US')} of ${plural(totals.spawns, 'spawn')} used the read-only Explore agent.`;
}

function homeNote(totals: Totals): string {
  return totals.homeSessions === 0
    ? ''
    : ` ${plural(totals.homeSessions, 'session')} started in your home folder, where no project CLAUDE.md loads.`;
}

export const RULES: readonly TipRule[] = [
  {
    id: 'context-reread',
    severity: 'high',
    title: 'Most of the spend is re-reading old context',
    advice: [
      'Every request sends the whole conversation again, so the 300th turn of a session costs far more than the 3rd. Start a new session for each task instead of continuing an old one.',
      'Use /clear when you switch to something unrelated, and /compact with a focus (for example "/compact keep the plan and the failing test") at natural breakpoints.',
      'Run /context to see what fills the window before deciding what to drop.',
    ],
    fixes: ['handoff', 'scout'],
    finding: (t) =>
      t.totalUsd < 1 || ratio(t.cacheReadUsd, t.totalUsd) < 0.4
        ? null
        : `${percent(ratio(t.cacheReadUsd, t.totalUsd))} of the ${usd(t.totalUsd)} estimated spend (${usd(t.cacheReadUsd)}) went to re-reading cached context. The average request carried ${tokens(ratio(t.contextTokens, t.requests))} tokens of conversation.`,
    flags: (m) => m.cost.cacheRead >= 1 && ratio(m.cost.cacheRead, sessionUsd(m)) >= 0.5,
    metric: (m) => m.cost.cacheRead,
    detail: (m) => `${usd(m.cost.cacheRead)} re-reading context`,
  },
  {
    id: 'huge-context',
    severity: 'high',
    title: 'Sessions grow huge without compacting',
    advice: [
      'Lower autoCompactWindow in Knobs (for example to 300000) so Claude Code compacts long before the 1M limit. Compaction keeps a summary and drops the bulk.',
      'Before a session gets that large, write a handoff note and carry on in a fresh session.',
    ],
    fixes: ['handoff'],
    finding: (t) =>
      t.largeSessions === 0
        ? null
        : `${plural(t.largeSessions, 'session')} went past ${tokens(LARGE_CONTEXT)} tokens of context, the largest to ${tokens(t.largestContext)}. Only ${plural(t.compactions, 'compaction')} happened across all sessions.`,
    flags: (m) => m.peakContext > LARGE_CONTEXT,
    metric: (m) => m.peakContext,
    detail: (m) => `${tokens(m.peakContext)} peak context`,
  },
  {
    id: 'idle-rewrite',
    severity: 'medium',
    title: 'Resuming big sessions after a break rewrites the cache',
    advice: [
      'After a long break, start a new session from a short summary instead of resuming a huge one.',
      'If you plan to come back, run /compact before stepping away so the rewrite is small.',
    ],
    fixes: ['handoff'],
    finding: (t) =>
      t.idleRewrites < 3
        ? null
        : `${plural(t.idleRewrites, 'time')} a large session was picked up after its prompt cache expired, so its whole context was written to the cache again, about ${usd(t.idleRewriteUsd)} in total.`,
    flags: (m) => m.idleRewrites > 0,
    metric: (m) => m.idleRewriteUsd,
    detail: (m) => `${plural(m.idleRewrites, 'rewrite')}, ${usd(m.idleRewriteUsd)}`,
  },
  {
    id: 'subagent-model',
    severity: 'medium',
    title: 'Subagents run on the most expensive models',
    advice: [
      'Set CLAUDE_CODE_SUBAGENT_MODEL in Knobs to sonnet, or haiku for pure searching, so subagents default to a cheaper model.',
      'Give your own agents a model field in their frontmatter.',
      'Ask for the Explore agent for read-only searches instead of general-purpose.',
    ],
    fixes: ['scout'],
    finding: (t) =>
      t.subagentRequests < 50 || ratio(t.premiumSubagentRequests, t.subagentRequests) < 0.8
        ? null
        : `${percent(ratio(t.premiumSubagentRequests, t.subagentRequests))} of ${plural(t.subagentRequests, 'subagent request')} ran on Opus or Fable, about ${usd(t.subagentUsd)} in total.${exploreNote(t)}`,
    flags: (m) => m.premiumSubagentRequests >= 10,
    metric: (m) => m.subagentUsd,
    detail: (m) => `${usd(m.subagentUsd)} in subagents`,
  },
  {
    id: 'big-results',
    severity: 'medium',
    title: 'Huge tool output stays in context',
    advice: [
      'Filter output before Claude sees it: grep, head and tail, quiet or summary flags, or write it to a file and read only the part that matters.',
      'Ask for line ranges of large files instead of whole files.',
      'BASH_MAX_OUTPUT_LENGTH in Knobs caps how many characters of Bash output come back.',
    ],
    fixes: ['quiet-run', 'scout'],
    finding: (t) =>
      t.bigResults < 3
        ? null
        : `${plural(t.bigResults, 'tool result')} were over 40K characters (about 10K tokens each), and each stayed in context for the rest of its session.`,
    flags: (m) => m.bigResults > 0,
    metric: (m) => m.bigResults,
    detail: (m) => plural(m.bigResults, 'huge result'),
  },
  {
    id: 'repeated-commands',
    severity: 'medium',
    title: 'The same commands run over and over',
    advice: [
      'Polling a build, server or CI run from the main session sends the whole context again each time. Ask Claude to run it in the background and wait for it, or hand it to an agent.',
      'When a fix and retry loop repeats the same command, stop and ask for a diagnosis before the next attempt.',
    ],
    fixes: ['ci-watch', 'dev-server', 'quiet-run'],
    finding: (t) =>
      t.repeatedRuns < 10 || t.topRepeat === null
        ? null
        : `Identical commands ran again ${plural(t.repeatedRuns, 'time')} after their second run. The most repeated ran ${plural(t.topRepeat.runs, 'time')}: ${t.topRepeat.command}`,
    flags: (m) => m.repeatedRuns >= 3,
    metric: (m) => m.repeatedRuns,
    detail: (m) => plural(m.repeatedRuns, 'repeat'),
  },
  {
    id: 'long-sessions',
    severity: 'medium',
    title: 'Long sessions mix several tasks',
    advice: [
      'Keep one task per session, and start the next one with the Launcher or a new Claude tab.',
      'Put facts every session needs in CLAUDE.md or a skill instead of building them up in a long conversation.',
    ],
    fixes: ['handoff'],
    finding: (t) =>
      t.longSessions < 2
        ? null
        : `${plural(t.longSessions, 'session')} ran past ${LONG_SESSION_PROMPTS.toString()} prompts, the longest to ${t.longestPrompts.toLocaleString('en-US')}. Each task in a long session pays for the context of the ones before it.`,
    flags: (m) => m.prompts > LONG_SESSION_PROMPTS,
    metric: (m) => m.prompts,
    detail: (m) => plural(m.prompts, 'prompt'),
  },
  {
    id: 'denials',
    severity: 'medium',
    title: 'Tool calls keep getting denied',
    advice: [
      'Run /fewer-permission-prompts to add allow rules for the read-only commands Claude keeps asking for.',
      'Add auto-approve rules in the Launcher for tools you always allow.',
      'Say in CLAUDE.md which commands are off limits, so Claude does not try them.',
    ],
    fixes: [],
    finding: (t) =>
      t.denials < 10
        ? null
        : `${plural(t.denials, 'tool call')} were denied by you or by the auto mode classifier. Each denial costs a round trip and usually a retry with another command.`,
    flags: (m) => m.denials >= 2,
    metric: (m) => m.denials,
    detail: (m) => plural(m.denials, 'denial'),
  },
  {
    id: 'rereads',
    severity: 'low',
    title: 'Files are read again and again',
    advice: [
      'Each read of a whole file adds it to context again. Ask for the lines you need, or grep for them.',
      'For files Claude needs in every session, a short summary in CLAUDE.md is cheaper than rereading them.',
    ],
    fixes: ['scout'],
    finding: (t) =>
      t.extraReads < 10
        ? null
        : `Files were read again ${plural(t.extraReads, 'time')} after their second read in the same session.`,
    flags: (m) => m.extraReads >= 3,
    metric: (m) => m.extraReads,
    detail: (m) => plural(m.extraReads, 'extra read'),
  },
  {
    id: 'tool-errors',
    severity: 'low',
    title: 'Many tool calls fail',
    advice: [
      'Put the exact build, test and lint commands in CLAUDE.md so Claude uses the right ones first.',
      'Note required setup (tools, environment variables, services) in CLAUDE.md so commands do not fail on a missing piece.',
    ],
    fixes: [],
    finding: (t) =>
      t.toolCalls < 100 || ratio(t.toolErrors - t.denials, t.toolCalls) < 0.05
        ? null
        : `${percent(ratio(t.toolErrors - t.denials, t.toolCalls))} of ${plural(t.toolCalls, 'tool call')} failed, not counting denials.`,
    flags: (m) => failures(m) >= 10 && ratio(failures(m), m.toolCalls) >= 0.1,
    metric: failures,
    detail: (m) => plural(failures(m), 'failure'),
  },
  {
    id: 'cd-commands',
    severity: 'low',
    title: 'Commands keep changing folders',
    advice: [
      "Start sessions in the project folder (the Launcher's folder field, or run claude from the repo) so project CLAUDE.md files and skills load and commands run in the right place.",
      'Claude Code can put the shell back in the session folder between commands, so a cd often has to be repeated. Absolute paths or git -C avoid that.',
    ],
    fixes: [],
    finding: (t) =>
      t.bashCommands < 100 || ratio(t.cdCommands, t.bashCommands) < 0.1
        ? null
        : `${percent(ratio(t.cdCommands, t.bashCommands))} of ${plural(t.bashCommands, 'shell command')} started with cd.${homeNote(t)}`,
    flags: (m) => m.cdCommands >= 10 && ratio(m.cdCommands, m.bashCommands) >= 0.2,
    metric: (m) => m.cdCommands,
    detail: (m) =>
      `${m.cdCommands.toLocaleString('en-US')} of ${plural(m.bashCommands, 'command')} start with cd`,
  },
];

const SEVERITY_ORDER: Readonly<Record<TipSeverity, number>> = { high: 0, medium: 1, low: 2 };

function worstSessions(rule: TipRule, measures: readonly SessionMeasure[]): TipSession[] {
  return measures
    .filter((measure) => rule.flags(measure))
    .toSorted((left, right) => rule.metric(right) - rule.metric(left))
    .slice(0, SESSIONS_PER_TIP)
    .map((measure) => ({
      sessionId: measure.sessionId,
      title: measure.title,
      detail: rule.detail(measure),
    }));
}

/** The tips that apply, most severe first, keeping rule order within a severity. */
export function buildTips(totals: Totals, measures: readonly SessionMeasure[]): Tip[] {
  const tips: Tip[] = [];
  for (const rule of RULES) {
    const finding = rule.finding(totals);
    if (finding !== null) {
      tips.push({
        id: rule.id,
        severity: rule.severity,
        title: rule.title,
        finding,
        advice: rule.advice,
        sessions: worstSessions(rule, measures),
        fixes: rule.fixes,
      });
    }
  }
  return tips.toSorted(
    (left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
  );
}

/** Ids of the applied tips that flag this session. */
export function tipsFor(measure: SessionMeasure, tips: readonly Tip[]): string[] {
  const applied = new Set(tips.map((tip) => tip.id));
  return RULES.filter((rule) => applied.has(rule.id) && rule.flags(measure)).map((rule) => rule.id);
}

/** Share of a session's cost that went to cache reads. */
export function cacheReadShare(measure: SessionMeasure): number {
  return ratio(measure.cost.cacheRead, costTotal(measure.cost) + measure.subagentUsd);
}
