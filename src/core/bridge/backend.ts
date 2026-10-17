// What a backend is: a model endpoint an agent can run on in place of its
// own account. The host starts the endpoint (the boisestate.ai sidecar today)
// and hands back its loopback URL and token, and the backend turns that into
// the env and args its agents need. The list of backends is in backends.ts.

import type { AgentId } from '../../shared/agents.js';

/** A running endpoint: its loopback URL and the token callers must present. */
export interface BackendEndpoint {
  readonly baseUrl: string;
  readonly token: string;
}

/** Starts a backend's endpoint, or returns the one already running. Throws when it cannot. */
export type EndpointSource = (backend: string) => Promise<BackendEndpoint>;

/** Where a session runs: a Launcher run on the SDK, or the CLI in a terminal tab. */
type BackendSurface = 'run' | 'tab';

export interface Backend {
  /** What a profile's backend field holds, such as "boisestate". */
  readonly id: string;
  /** What a pick shows, such as "Boise State (Opus 5.5)". */
  readonly name: string;
  /** The line under the name in a pick. */
  readonly description: string;
  /** The name a tab on this backend takes. */
  readonly short: string;
  readonly appliesTo: (agent: AgentId) => boolean;
  /** Variables laid over the session's env so the agent talks to the endpoint. */
  readonly env: (
    agent: AgentId,
    endpoint: BackendEndpoint,
    surface: BackendSurface,
  ) => Record<string, string>;
  /** CLI args a tab puts before its own, such as the backend's model. */
  readonly tabArgs: (agent: AgentId) => readonly string[];
  /** The backend sends every tool's definition as text, so its sessions run with no MCP servers. */
  readonly noMcp: boolean;
  /** The endpoint goes away with the window, so its sessions run in their tab, not the background. */
  readonly windowBound: boolean;
  /**
   * The permission mode a session starts in when it would otherwise run in
   * auto mode. Auto mode asks a model to approve every tool call, and on a
   * metered backend that model bills the same quota. Null leaves the mode alone.
   */
  readonly safeMode: string | null;
  /** True when an env from before profiles had a backend field opts into this one. */
  readonly claims: (env: Readonly<Record<string, string>>) => boolean;
}
