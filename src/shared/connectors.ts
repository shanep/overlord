// What the Connectors view shows: every MCP server each agent knows about,
// claude.ai connectors and Claude in Chrome for Claude Code, and a headless
// Chrome any agent can drive, each with whether a session could use it right
// now, and a search of the public MCP registry for servers to add.

import type { AgentId } from './agents.js';
import { CLAUDE_CODE } from './agents.js';

/** Where a connector comes from. */
export type ConnectorKind = 'mcp' | 'claude.ai' | 'chrome' | 'headless';

/**
 * `ok` means a session can use it now. `needs-auth` wants a sign in,
 * `pending` waits on approval of a project .mcp.json, `missing` means it is
 * not set up or nothing is attached, `unknown` is a status we could not read,
 * and `unchecked` is set up in an agent whose CLI does not report health.
 */
export type ConnectorStatus =
  'ok' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'missing' | 'unknown' | 'unchecked';

/** A one click fix the view can offer. */
export type ConnectorFix = 'sign-in' | 'open-chrome';

export interface Connector {
  /** Stable across checks: the kind plus the name. */
  readonly id: string;
  readonly name: string;
  readonly kind: ConnectorKind;
  /** The command, URL or binary behind it. */
  readonly target: string;
  readonly status: ConnectorStatus;
  /** What the status means here, or what to do about it. */
  readonly detail: string;
  readonly fix: ConnectorFix | null;
  /** The agent whose config holds it. Unset means Claude Code, as every row was before other agents. */
  readonly agent?: AgentId;
}

/** The agent a row belongs to, or null for a headless Chrome, which any agent can drive. */
export function connectorAgent(connector: Connector): AgentId | null {
  return connector.kind === 'headless' ? null : (connector.agent ?? CLAUDE_CODE);
}

/** The rows a session of this agent can reach. */
export function connectorsFor(agent: AgentId, connectors: readonly Connector[]): Connector[] {
  return connectors.filter((connector) => {
    const owner = connectorAgent(connector);
    return owner === null || owner === agent;
  });
}

/** How a server from the MCP registry runs: a remote URL, or a package run on this machine. */
export type InstallKind = 'http' | 'sse' | 'npm' | 'pypi' | 'docker';

/** A value the user fills in before an install: an API key, a header or a path. */
export interface InstallInput {
  /** Unique within its option: env:NAME, header:NAME, arg:NAME or var:NAME. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
  /** The registry's default, filled in to start with. */
  readonly initial: string;
  readonly placeholder: string;
}

/** One way to install a server. A server can offer a remote URL and a package. */
export interface InstallOption {
  readonly kind: InstallKind;
  /** The URL it connects to, or the command it runs. */
  readonly summary: string;
  readonly inputs: readonly InstallInput[];
}

/** A server from the MCP registry, with the ways Overlord knows how to install it. */
export interface RegistryServer {
  /** The registry name, such as io.github.getsentry/sentry-mcp. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly repository: string | null;
  /** The name to give it in the agent, which the user can change. */
  readonly suggestedName: string;
  /** Empty when every way it ships is one Overlord cannot install, such as an .mcpb bundle. */
  readonly options: readonly InstallOption[];
}

/** How the last install went, shown above the search results. */
export interface InstallNotice {
  readonly ok: boolean;
  readonly text: string;
}

/** The registry search in the Connectors view. */
export interface RegistryState {
  /** The query the results are for, or null before the first search. */
  readonly query: string | null;
  readonly searching: boolean;
  readonly results: readonly RegistryServer[];
  /** True when the registry has more matches than it sent. */
  readonly more: boolean;
  /** True while the next page loads. */
  readonly loadingMore: boolean;
  readonly error: string | null;
  /** The registry name being installed right now. */
  readonly installing: string | null;
  readonly notice: InstallNotice | null;
}

export const EMPTY_REGISTRY: RegistryState = {
  query: null,
  searching: false,
  results: [],
  more: false,
  loadingMore: false,
  error: null,
  installing: null,
  notice: null,
};

export interface ConnectorsState {
  readonly connectors: readonly Connector[];
  /** When the last check finished, or null before the first one. */
  readonly checkedAt: number | null;
  readonly checking: boolean;
  /** The folder `claude mcp list` ran in, which decides the project scoped servers. */
  readonly folder: string | null;
  /** The agents a registry server can be added to: Claude Code, then each other installed one with an MCP store. */
  readonly mcpAgents: readonly AgentId[];
  readonly registry: RegistryState;
}
