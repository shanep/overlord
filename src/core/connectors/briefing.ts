// The note every new session gets when it starts: which connectors worked at
// the last check, which did not, and the rule to check the ones a task needs
// before starting on it, so a missing one stops the work at the start instead
// of halfway through. It is plain text. The session's agent decides how it
// gets there (its inject facet), which for Claude Code is the SessionStart
// hook's additionalContext.

import type { Connector, ConnectorsState } from '../../shared/connectors.js';

const STATUS_WORDS: Readonly<Record<Connector['status'], string>> = {
  ok: 'ready',
  'needs-auth': 'needs sign in',
  failed: 'failed to connect',
  pending: 'waiting for approval',
  disabled: 'disabled',
  missing: 'not available',
  unknown: 'status unknown',
  unchecked: 'set up, not checked',
};

/** What the rule says for one agent: the connectors it names, and whether it has subagents. */
export interface CheckWords {
  readonly examples: { readonly examples: string; readonly probe: string } | null;
  readonly subagents: boolean;
}

/** The rule in the session's agent's words. Claude Code's names Chrome and its subagents. */
export function checkRule(words: CheckWords): string {
  const { examples } = words;
  return [
    'Before you start a plan or any multi-step task, list the connectors and MCP tools it will need',
    ...(examples === null ? [] : [`(for example ${examples.examples})`]),
    'and confirm each one works now: its tools are in your tool list and, when in doubt, one cheap',
    examples === null
      ? 'read-only call to it succeeds.'
      : `read-only call to it succeeds (such as ${examples.probe}).`,
    'If any needed connector is missing, not signed in or failing, stop before doing any of the work',
    'and tell the user which one and how to fix it. When you write a plan, put this check and its',
    'result at the top of the plan.',
    ...(words.subagents
      ? ['Subagents you start rely on the same connectors, so check for them too.']
      : []),
  ].join(' ');
}

/** The rule as Claude Code gets it. */
export const CHECK_RULE = checkRule({
  examples: {
    examples: 'Claude in Chrome, a headless browser, Google Docs, Drive, Gmail or Calendar',
    probe: 'list_connected_browsers for Chrome',
  },
  subagents: true,
});

function line(connector: Connector): string {
  const status = STATUS_WORDS[connector.status];
  return connector.status === 'ok'
    ? `- ${connector.name}: ${status}`
    : `- ${connector.name}: ${status}. ${connector.detail}`;
}

/** The connector note for a new session. */
export function connectorBriefing(
  state: Pick<ConnectorsState, 'connectors' | 'checkedAt'>,
  formatTime: (at: number) => string,
  rule = CHECK_RULE,
): string {
  const heading = 'Overlord connector check.';
  if (state.checkedAt === null || state.connectors.length === 0) {
    return `${heading} ${rule}`;
  }
  const problems = state.connectors.filter((connector) => connector.status !== 'ok');
  const ready = state.connectors.filter((connector) => connector.status === 'ok');
  const sections = [
    `${heading} Status at ${formatTime(state.checkedAt)}; it may have changed since.`,
    ...(problems.length === 0
      ? ['Every connector was ready.']
      : ['Not ready:', ...problems.map((connector) => line(connector))]),
    ...(ready.length === 0 ? [] : ['Ready:', ...ready.map((connector) => line(connector))]),
    rule,
  ];
  return sections.join('\n');
}
