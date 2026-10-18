// Turns the rules into the tips the view shows, with the measured impact of
// the ones you track, and finds the tips a step taken from Overlord follows.

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { Tip, TipSession, TipSeverity } from '../../shared/tuning.js';

import type { TuningAgent } from './agent.js';
import { inAgentWords, ruleFits, ruleKnobs } from './agent.js';
import type { FixContext } from './fixes.js';
import { autoFixesFor } from './fixes.js';
import { impactOf } from './impact.js';
import type { SessionMeasure } from './measure.js';
import type { TipRule } from './rules.js';
import { RULES } from './rules.js';
import type { Totals } from './totals.js';

const SESSIONS_PER_TIP = 5;

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

export interface TipInputs {
  readonly totals: Totals;
  /** Sessions whose transcript is still on disk. */
  readonly live: readonly SessionMeasure[];
  /** Every session measured, history included, for the impact of tracked tips. */
  readonly all: readonly SessionMeasure[];
  /** When you started following each tracked tip, by tip id. */
  readonly tracked: ReadonlyMap<string, number>;
  readonly now: number;
  /** The agent whose sessions these are. Unset is Claude Code, whose words the rules use. */
  readonly agent?: TuningAgent;
  /** What the fixes need to know about this machine. Unset offers no session to start. */
  readonly fixEnv?: FixEnv;
}

type FixEnv = Omit<FixContext, 'totals' | 'live'>;

const NO_ENV: FixEnv = {
  hotFiles: [],
  knob: () => null,
  installed: new Set(),
  home: '',
  projectOf: (cwd) => cwd,
  modifiedAt: () => null,
};

/** Every text of a rule that shows, to check the agent has a word for each name in it. */
function ruleTexts(rule: TipRule): readonly string[] {
  return [rule.title, ...rule.advice, ...rule.pros, ...rule.cons, rule.skipWhen];
}

/** The rules that fit the agent, or all of them for Claude Code. */
function rulesFor(agent: TuningAgent | undefined): readonly TipRule[] {
  return agent === undefined
    ? RULES
    : RULES.filter((rule) => ruleFits(rule, ruleTexts(rule), agent));
}

const NO_LONGER =
  'This no longer stands out across your sessions. It stays here while you track it.';

/**
 * The tips that apply, most severe first, keeping rule order within a
 * severity. A tracked tip stays even once the habit no longer stands out, so
 * you can still see how it went.
 */
export function buildTips(inputs: TipInputs): Tip[] {
  const tips: Tip[] = [];
  const { agent } = inputs;
  const say = (text: string): string => (agent === undefined ? text : inAgentWords(text, agent));
  const fixContext: FixContext = {
    ...(inputs.fixEnv ?? NO_ENV),
    totals: inputs.totals,
    live: inputs.live,
  };
  for (const rule of rulesFor(agent)) {
    const finding = rule.finding(inputs.totals);
    const since = inputs.tracked.get(rule.id);
    if (finding === null && since === undefined) {
      continue;
    }
    tips.push({
      id: rule.id,
      severity: rule.severity,
      title: say(rule.title),
      finding: say(finding ?? NO_LONGER),
      advice: rule.advice.map((text) => say(text)),
      sessions: worstSessions(rule, inputs.live),
      fixes: rule.fixes,
      // The fixes write Claude Code's settings and start Claude Code sessions.
      autoFixes:
        agent === undefined || agent.id === CLAUDE_CODE ? autoFixesFor(rule.id, fixContext) : [],
      pros: rule.pros.map((text) => say(text)),
      cons: rule.cons.map((text) => say(text)),
      skipWhen: say(rule.skipWhen),
      impact:
        since === undefined
          ? null
          : impactOf({ tracking: rule.track, since, measures: inputs.all, now: inputs.now }),
    });
  }
  return tips.toSorted(
    (left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
  );
}

/** Something done from Overlord that follows a tip's advice. */
export type AdviceStep =
  | { readonly kind: 'knob'; readonly key: string }
  | { readonly kind: 'suggestion'; readonly id: string };

/** Ids of the tips whose advice this step follows, for the agent whose knob it set. */
export function tipsTakenBy(step: AdviceStep, agent?: TuningAgent): string[] {
  const knobs = (rule: TipRule): readonly string[] =>
    agent === undefined ? (rule.knobs ?? []) : ruleKnobs(rule, agent);
  return rulesFor(agent)
    .filter((rule) =>
      step.kind === 'knob' ? knobs(rule).includes(step.key) : rule.fixes.includes(step.id),
    )
    .map((rule) => rule.id);
}

/** True when `id` names a tip rule. */
export function isTipId(id: string): boolean {
  return RULES.some((rule) => rule.id === id);
}

/** Ids of the applied tips that flag this session. */
export function tipsFor(measure: SessionMeasure, tips: readonly Tip[]): string[] {
  const applied = new Set(tips.map((tip) => tip.id));
  return RULES.filter((rule) => applied.has(rule.id) && rule.flags(measure)).map((rule) => rule.id);
}
