// The steps an apply plan is made of, and the dry run text the UI shows
// before anything runs. Paths in actions are absolute.

import type { AgentId } from '../../shared/agents.js';
import type { SettingsFormat } from '../knobs/facet.js';

import type { SettingEntry } from './agent-settings.js';
import type { JsonRecord } from './json.js';
import { collapseHome } from './layout.js';

export type Action =
  | { readonly kind: 'mkdir'; readonly path: string }
  /**
   * Copy `path` into the run's backup folder before anything overwrites or
   * removes it. Another agent's files go in a folder named for the agent.
   */
  | { readonly kind: 'backup'; readonly path: string; readonly agent?: AgentId }
  | { readonly kind: 'link'; readonly source: string; readonly target: string }
  | { readonly kind: 'copy'; readonly source: string; readonly target: string }
  | { readonly kind: 'generate-settings'; readonly target: string; readonly content: string }
  | { readonly kind: 'write-file'; readonly target: string; readonly content: string }
  /** Only allowed when the same plan backs `path` up first. */
  | { readonly kind: 'remove'; readonly path: string }
  | {
      readonly kind: 'run-command';
      readonly command: string;
      /** May hold ${secret:NAME} placeholders, filled in at apply time. */
      readonly args: readonly string[];
      readonly description: string;
    }
  | { readonly kind: 'clone-external'; readonly repoUrl: string; readonly destination: string }
  /** Set these keys in an agent's settings file one at a time. Only allowed when the plan backs `target` up first. */
  | {
      readonly kind: 'set-keys';
      readonly agent: AgentId;
      readonly target: string;
      readonly format: SettingsFormat;
      readonly entries: readonly SettingEntry[];
    }
  /** Add a user MCP server through the agent's own MCP store. */
  | {
      readonly kind: 'mcp-add';
      readonly agent: AgentId;
      /** The agent's short name, for the dry run. */
      readonly short: string;
      readonly name: string;
      /** May hold ${secret:NAME} placeholders, filled in at apply time. */
      readonly config: JsonRecord;
    }
  /** Remove a user MCP server through the agent's MCP store, so a changed one can be added again. */
  | {
      readonly kind: 'mcp-remove';
      readonly agent: AgentId;
      readonly short: string;
      readonly name: string;
    }
  /** Keep a secret taken out of a config in the keychain. The value never shows in a dry run. */
  | { readonly kind: 'save-secret'; readonly name: string; readonly value: string }
  /** Something the user should know about. Applying it does nothing. */
  | { readonly kind: 'note'; readonly message: string };

const MAX_ARG_CHARS = 80;

function shortPart(part: string): string {
  const quoted = /[\s"'{}]/u.test(part) ? `'${part}'` : part;
  return quoted.length > MAX_ARG_CHARS ? `${quoted.slice(0, MAX_ARG_CHARS - 3)}...` : quoted;
}

/** The steps that change another agent's config, or the keychain. */
export type AgentStep = Extract<
  Action,
  { readonly kind: 'set-keys' | 'mcp-add' | 'mcp-remove' | 'save-secret' }
>;

const AGENT_STEPS: ReadonlySet<Action['kind']> = new Set([
  'set-keys',
  'mcp-add',
  'mcp-remove',
  'save-secret',
]);

export function isAgentStep(action: Action): action is AgentStep {
  return AGENT_STEPS.has(action.kind);
}

function describeAgentStep(action: AgentStep, home: string): string {
  switch (action.kind) {
    case 'set-keys': {
      const keys = action.entries.map((entry) => entry.path.join('.')).join(', ');
      const cut = keys.length > MAX_ARG_CHARS ? `${keys.slice(0, MAX_ARG_CHARS - 3)}...` : keys;
      return `set     ${cut} in ${collapseHome(action.target, home)}`;
    }
    case 'mcp-add': {
      return `mcp     add ${action.name} to ${action.short}`;
    }
    case 'mcp-remove': {
      return `mcp     remove ${action.name} from ${action.short} to add it again`;
    }
    case 'save-secret': {
      return `secret  ${action.name} (saved in the keychain)`;
    }
  }
}

export function describeAction(action: Action, home: string): string {
  if (isAgentStep(action)) {
    return describeAgentStep(action, home);
  }
  const short = (target: string): string => collapseHome(target, home);
  switch (action.kind) {
    case 'mkdir': {
      return `mkdir   ${short(action.path)}`;
    }
    case 'backup': {
      return `backup  ${short(action.path)}`;
    }
    case 'link': {
      return `link    ${short(action.target)} -> ${short(action.source)}`;
    }
    case 'copy': {
      return `copy    ${short(action.source)} to ${short(action.target)}`;
    }
    case 'generate-settings': {
      return `write   ${short(action.target)} (generated settings)`;
    }
    case 'write-file': {
      return `write   ${short(action.target)}`;
    }
    case 'remove': {
      return `remove  ${short(action.path)} (backed up first)`;
    }
    case 'run-command': {
      const line = [action.command, ...action.args].map((part) => shortPart(part)).join(' ');
      return `run     ${line} (${action.description})`;
    }
    case 'clone-external': {
      return `clone   ${action.repoUrl} into ${short(action.destination)}`;
    }
    case 'note': {
      return `note    ${action.message}`;
    }
  }
}

/** The dry run, one line per action. Secrets show as placeholders, never values. */
export function summarizePlan(actions: readonly Action[], home: string): string {
  const changes = actions.filter((action) => action.kind !== 'note').length;
  if (actions.length === 0) {
    return 'Nothing to do. Everything already matches the config repo.\n';
  }
  const header = `${String(changes)} change${changes === 1 ? '' : 's'} planned:`;
  const lines = actions.map((action) => `  ${describeAction(action, home)}`);
  return `${[header, ...lines].join('\n')}\n`;
}
