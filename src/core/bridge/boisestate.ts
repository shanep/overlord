// The pure pieces that tie Overlord's launch flow to the boisestate.ai bridge
// sidecar. A launch profile opts in with backend "boisestate", or the older
// way, by setting ANTHROPIC_BASE_URL to the placeholder below. At launch time
// the session's env points at the running sidecar's loopback URL with the
// bridge token as its key. The host owns the spawn and the key, so nothing
// here imports vscode or touches a process.

import { z } from 'zod';

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { LaunchProfile } from '../../shared/model.js';

import type { Backend } from './backend.js';

/** The ANTHROPIC_BASE_URL value an older profile uses to say "route me through the bridge". */
export const BRIDGE_BASE_URL = 'overlord://boisestate';

/** The env key a Claude Code session reads its endpoint from. */
const BASE_URL = 'ANTHROPIC_BASE_URL';

const BOISESTATE_ID = 'boisestate';

/** SecretStorage key holding the boisestate.ai api key. */
export const BOISESTATE_KEY_SECRET = 'overlord.boisestate.apiKey';

/** The model bridge sessions ask for, which the bridge maps to the backend's Opus 5.5. */
const BRIDGE_MODEL = 'claude-opus-5-5';

/** The seeded profile that routes a session through the bridge, on Opus 5.5. */
export const BOISESTATE_PROFILE: LaunchProfile = {
  id: BOISESTATE_ID,
  name: 'Boise State (Opus 5.5)',
  agent: CLAUDE_CODE,
  backend: BOISESTATE_ID,
  model: BRIDGE_MODEL,
  effort: null,
  permissionMode: null,
  env: {},
  extraArgs: [],
};

/**
 * The boisestate.ai bridge, for Claude Code. A Launcher run gets the token as
 * ANTHROPIC_API_KEY. A tab gets it as ANTHROPIC_AUTH_TOKEN, a bearer token,
 * since the CLI asks the user to approve every new ANTHROPIC_API_KEY and the
 * token changes each time the sidecar starts.
 */
export const BOISESTATE: Backend = {
  id: BOISESTATE_ID,
  name: 'Boise State (Opus 5.5)',
  description: 'through the boisestate.ai bridge',
  short: 'Boise State',
  appliesTo: (agent) => agent === CLAUDE_CODE,
  env: (_agent, endpoint, surface) => ({
    [BASE_URL]: endpoint.baseUrl,
    [surface === 'tab' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: endpoint.token,
  }),
  // The bridge's model, no MCP servers, since the bridge sends every tool's
  // definition as text in each request, and not auto mode. Auto mode's
  // approval checks ran on Sonnet through the bridge, about six 55k-token
  // calls per turn, and used up a month's quota in under an hour.
  tabArgs: () => ['--model', BRIDGE_MODEL, '--strict-mcp-config', '--permission-mode', 'default'],
  noMcp: true,
  windowBound: true,
  safeMode: 'default',
  claims: (env) => env[BASE_URL] === BRIDGE_BASE_URL,
};

const readySchema = z.object({ ready: z.literal(true), port: z.number().int().positive() });

/** The port from the sidecar's `{"ready":true,"port":N}` stdout line, or null. */
export function parseReadyLine(line: string): number | null {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = readySchema.safeParse(value);
  return parsed.success ? parsed.data.port : null;
}
