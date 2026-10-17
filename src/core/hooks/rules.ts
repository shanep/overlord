// Auto-approve rules for permission requests. Deny rules always win over
// allow rules, and disabled rules are ignored. A SendMessage rule pattern
// matches the message's recipient (the tool's `to` input). Each rule applies
// to one agent or to every agent, and a rule saved before rules had an agent
// applies to Claude Code alone, so an old Bash rule never starts approving
// another agent's shell. A rule names Claude's tools, and for the other
// agents it scopes to it also covers their names for the shell, so a Bash
// rule matches Copilot's bash hook tool, the ACP kind execute and Codex's
// exec_command.

import picomatch from 'picomatch';

import type { AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { AutoApproveRule } from '../../shared/rules.js';
import { ALL_AGENTS } from '../../shared/rules.js';

export interface RuleMatch {
  readonly behavior: 'allow' | 'deny';
  readonly ruleId: string;
}

/** What a rule pattern is matched against: a Bash command, a file tool path, or a message recipient. */
export type RuleSubject =
  | { readonly kind: 'command'; readonly value: string }
  | { readonly kind: 'path'; readonly value: string }
  | { readonly kind: 'recipient'; readonly value: string };

type Matcher = (value: string) => boolean;

const PATH_KEYS: readonly string[] = ['file_path', 'path', 'notebook_path'];

// Shell syntax that runs more than one command or feeds one command into
// another. An allow rule never matches such a command, because "git status*"
// should not approve "git status && rm -rf ~".
const COMPOUND_COMMAND = /[;&|`<>\n\r]|\$\(/u;

/** Claude's name for another agent's shell tool. */
const CLAUDE_SHELLS: ReadonlyMap<string, string> = new Map([
  ['bash', 'Bash'],
  ['execute', 'Bash'],
  ['exec_command', 'Bash'],
]);

/** The agent a rule applies to: its own, or Claude Code for a rule saved before rules had one. */
export function ruleAgent(rule: AutoApproveRule): AgentId {
  return rule.agent ?? CLAUDE_CODE;
}

/** True when the rule applies to requests from this agent. */
export function ruleCovers(rule: AutoApproveRule, agent: AgentId): boolean {
  const scope = ruleAgent(rule);
  return scope === ALL_AGENTS || scope === agent;
}

function isShell(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'PowerShell' || CLAUDE_SHELLS.has(toolName);
}

const cache = new Map<string, Matcher>();

function compile(pattern: string, bash: boolean): Matcher {
  const key = `${bash ? 'b' : 'p'}:${pattern}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let matcher: Matcher;
  try {
    // bash mode lets a single star cross slashes, which suits commands.
    matcher = picomatch(pattern, { dot: true, bash });
  } catch {
    matcher = (): boolean => false;
  }
  cache.set(key, matcher);
  return matcher;
}

/** A string field of a tool input, or null when it is missing or not a string. */
export function stringField(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null || !(key in input)) {
    return null;
  }
  const value: unknown = Reflect.get(input, key);
  return typeof value === 'string' ? value : null;
}

export const SEND_MESSAGE_TOOL = 'SendMessage';

export function ruleSubject(toolName: string, input: unknown): RuleSubject | null {
  if (toolName === SEND_MESSAGE_TOOL) {
    const to = stringField(input, 'to');
    return to === null ? null : { kind: 'recipient', value: to };
  }
  const command = stringField(input, 'command');
  if (command !== null && isShell(toolName)) {
    return { kind: 'command', value: command };
  }
  for (const key of PATH_KEYS) {
    const value = stringField(input, key);
    if (value !== null) {
      return { kind: 'path', value };
    }
  }
  return command === null ? null : { kind: 'command', value: command };
}

export function isCompoundCommand(command: string): boolean {
  return COMPOUND_COMMAND.test(command);
}

/**
 * A rule pattern that matches exactly this text, which must have no
 * backslash: picomatch has no exact form for one (an escaped backslash breaks
 * the escape after it, and a bracketed one also matches "[\\]").
 */
export function literalPattern(text: string): string {
  return text.replaceAll(/[^\s\w/-]/gu, (char) => `\\${char}`);
}

/**
 * The allow rule that stops a request like this one from asking again: the
 * exact command for a shell tool, else the whole tool. Null for a compound
 * command, since no allow rule ever matches one, and for a command with a
 * backslash, since no pattern matches it exactly.
 */
export function alwaysAllowRule(
  agent: AgentId,
  toolName: string,
  input: unknown,
  id: string,
): AutoApproveRule | null {
  const subject = ruleSubject(toolName, input);
  const command = subject?.kind === 'command' ? subject.value : null;
  if (command !== null && (isCompoundCommand(command) || command.includes('\\'))) {
    return null;
  }
  return {
    id,
    enabled: true,
    behavior: 'allow',
    tool: literalPattern(toolName),
    pattern: command === null ? null : literalPattern(command.trim()),
    description: 'Added by Always allow',
    agent,
  };
}

function patternMatches(rule: AutoApproveRule, subject: RuleSubject | null): boolean {
  if (rule.pattern === null) {
    return true;
  }
  if (subject === null) {
    return false;
  }
  if (subject.kind === 'command') {
    if (rule.behavior === 'allow' && isCompoundCommand(subject.value)) {
      return false;
    }
    return compile(rule.pattern, true)(subject.value.trim());
  }
  // Recipients such as "uds:/tmp/cc-socks/1.sock" have slashes, so a star crosses them.
  return compile(rule.pattern, subject.kind === 'recipient')(subject.value);
}

/**
 * True when a rule's tool pattern covers the tool, whether or not the rule is
 * enabled. Another agent's shell also answers to Claude's name for it, Bash.
 */
export function toolPatternMatches(
  pattern: string,
  toolName: string,
  agent: AgentId = CLAUDE_CODE,
): boolean {
  const matcher = compile(pattern, false);
  if (matcher(toolName)) {
    return true;
  }
  const claude = agent === CLAUDE_CODE ? undefined : CLAUDE_SHELLS.get(toolName);
  return claude !== undefined && matcher(claude);
}

/** True when the rule is on, applies to the agent, and covers this call. */
export function ruleMatches(
  rule: AutoApproveRule,
  agent: AgentId,
  toolName: string,
  input: unknown,
): boolean {
  if (
    !rule.enabled ||
    !ruleCovers(rule, agent) ||
    !toolPatternMatches(rule.tool, toolName, agent)
  ) {
    return false;
  }
  return patternMatches(rule, ruleSubject(toolName, input));
}

/** The rule that decides a request: the first matching deny rule, else the first matching allow rule. */
export function findMatchingRule(
  rules: readonly AutoApproveRule[],
  agent: AgentId,
  toolName: string,
  input: unknown,
): AutoApproveRule | null {
  let allow: AutoApproveRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, agent, toolName, input)) {
      continue;
    }
    if (rule.behavior === 'deny') {
      return rule;
    }
    allow ??= rule;
  }
  return allow;
}

export function evaluateRules(
  rules: readonly AutoApproveRule[],
  agent: AgentId,
  toolName: string,
  input: unknown,
): RuleMatch | null {
  const rule = findMatchingRule(rules, agent, toolName, input);
  return rule === null ? null : { behavior: rule.behavior, ruleId: rule.id };
}
