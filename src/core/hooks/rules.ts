// Auto-approve rules for permission requests. Deny rules always win over
// allow rules, and disabled rules are ignored. A SendMessage rule pattern
// matches the message's recipient (the tool's `to` input).

import picomatch from 'picomatch';

import type { AutoApproveRule } from '../../shared/protocol.js';

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

function stringField(input: unknown, key: string): string | null {
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
  if (command !== null && (toolName === 'Bash' || toolName === 'PowerShell')) {
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

/** True when a rule's tool pattern covers the tool, whether or not the rule is enabled. */
export function toolPatternMatches(pattern: string, toolName: string): boolean {
  return compile(pattern, false)(toolName);
}

export function ruleMatches(rule: AutoApproveRule, toolName: string, input: unknown): boolean {
  if (!rule.enabled || !toolPatternMatches(rule.tool, toolName)) {
    return false;
  }
  return patternMatches(rule, ruleSubject(toolName, input));
}

/** The rule that decides a request: the first matching deny rule, else the first matching allow rule. */
export function findMatchingRule(
  rules: readonly AutoApproveRule[],
  toolName: string,
  input: unknown,
): AutoApproveRule | null {
  let allow: AutoApproveRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, toolName, input)) {
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
  toolName: string,
  input: unknown,
): RuleMatch | null {
  const rule = findMatchingRule(rules, toolName, input);
  return rule === null ? null : { behavior: rule.behavior, ruleId: rule.id };
}
