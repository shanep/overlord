// What the Connectors view shows: every MCP server and claude.ai connector
// Claude Code knows about, plus Claude in Chrome and a headless Chrome, each
// with whether a session could use it right now.

/** Where a connector comes from. */
export type ConnectorKind = 'mcp' | 'claude.ai' | 'chrome' | 'headless';

/**
 * `ok` means a session can use it now. `needs-auth` wants a sign in,
 * `pending` waits on approval of a project .mcp.json, `missing` means it is
 * not set up or nothing is attached, and `unknown` is a status we could not read.
 */
export type ConnectorStatus =
  'ok' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'missing' | 'unknown';

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
}

export interface ConnectorsState {
  readonly connectors: readonly Connector[];
  /** When the last check finished, or null before the first one. */
  readonly checkedAt: number | null;
  readonly checking: boolean;
  /** The folder `claude mcp list` ran in, which decides the project scoped servers. */
  readonly folder: string | null;
}
