// Which tip rules fit an agent, and the rule text in the agent's words. The
// rules are written for Claude Code, so for Claude Code nothing changes. For
// another agent, rules that name Claude Code's own settings are left out,
// rules that need a capability it lacks are left out, and the names of the
// instruction file and the commands are swapped for the agent's own.

import type { AgentCapabilities, AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { AgentAdapter, AgentWords } from '../agents/types.js';

/** The capabilities that are on or off, as opposed to lists. */
type CapabilityFlag = {
  readonly [K in keyof AgentCapabilities]: AgentCapabilities[K] extends boolean ? K : never;
}[keyof AgentCapabilities];

/** What the rules need to know about the agent whose sessions they read. */
export interface TuningAgent {
  readonly id: AgentId;
  readonly name: string;
  readonly short: string;
  readonly capabilities: AgentCapabilities;
  /** Null when the agent names none, so rules that mention a command are left out. */
  readonly words: AgentWords | null;
  /** Knob ids by tip id, for an agent whose knobs differ from Claude Code's. */
  readonly knobs: Readonly<Record<string, readonly string[]>>;
}

/** What a rule says about which agents it fits. */
export interface RuleFit {
  readonly id: string;
  /** Capabilities the rule's finding depends on, such as cache reads. */
  readonly needs?: readonly CapabilityFlag[];
  /** Agents the rule fits, when its advice names one agent's own settings. Unset fits all. */
  readonly only?: readonly AgentId[];
  readonly knobs?: readonly string[];
}

export function tuningAgent(
  adapter: Pick<AgentAdapter, 'id' | 'name' | 'short' | 'capabilities' | 'words' | 'tuning'>,
): TuningAgent {
  return {
    id: adapter.id,
    name: adapter.name,
    short: adapter.short,
    capabilities: adapter.capabilities,
    words: adapter.words ?? null,
    knobs: adapter.tuning?.knobs ?? {},
  };
}

// The names in the rules' text, longest first so "Claude Code" goes before
// "Claude", each with the word that replaces it for another agent.
type Swap = readonly [claude: string, theirs: (agent: TuningAgent) => string | null];

const SWAPS: readonly Swap[] = [
  ['Claude Code', (agent): string => agent.name],
  ['CLAUDE.md', (agent): string | null => agent.words?.instructionsFile ?? null],
  ['/compact', (agent): string | null => agent.words?.compactCommand ?? null],
  ['/clear', (agent): string | null => agent.words?.clearCommand ?? null],
  ['Claude', (agent): string => agent.short],
];

/** True when every name the texts use has a word for this agent. */
function canSay(texts: readonly string[], agent: TuningAgent): boolean {
  return SWAPS.every(
    ([claude, theirs]) => theirs(agent) !== null || texts.every((text) => !text.includes(claude)),
  );
}

/** A rule's text in the agent's words. Claude Code's text comes back as it is. */
export function inAgentWords(text: string, agent: TuningAgent): string {
  if (agent.id === CLAUDE_CODE) {
    return text;
  }
  let out = text;
  for (const [claude, theirs] of SWAPS) {
    const word = theirs(agent);
    if (word !== null) {
      out = out.replaceAll(claude, word);
    }
  }
  return out;
}

/** True when the rule fits the agent: its own settings, the capabilities it needs and the words it uses. */
export function ruleFits(rule: RuleFit, texts: readonly string[], agent: TuningAgent): boolean {
  if (agent.id === CLAUDE_CODE) {
    return true;
  }
  const only = rule.only === undefined || rule.only.includes(agent.id);
  const needs = (rule.needs ?? []).every((flag) => agent.capabilities[flag]);
  return only && needs && canSay(texts, agent);
}

/** The knobs the rule's advice sets for this agent. */
export function ruleKnobs(rule: RuleFit, agent: TuningAgent): readonly string[] {
  return agent.id === CLAUDE_CODE ? (rule.knobs ?? []) : (agent.knobs[rule.id] ?? []);
}
