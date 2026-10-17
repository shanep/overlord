// The pure pieces that tie Overlord's launch flow to the boisestate.ai bridge
// sidecar. A launch profile opts in by setting ANTHROPIC_BASE_URL to the
// placeholder below; at launch time the host swaps it for the running sidecar's
// loopback URL and sets the bridge token as the api key. The host owns the
// spawn and the key, so nothing here imports vscode or touches a process.

import { z } from 'zod';

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { LaunchProfile } from '../../shared/model.js';

/** The ANTHROPIC_BASE_URL value a profile uses to say "route me through the bridge". */
export const BRIDGE_BASE_URL = 'overlord://boisestate';

/** SecretStorage key holding the boisestate.ai api key. */
export const BOISESTATE_KEY_SECRET = 'overlord.boisestate.apiKey';

/** A running sidecar: its loopback URL and the shared token callers must present. */
export interface BridgeEndpoint {
  readonly baseUrl: string;
  readonly token: string;
}

/** The model bridge sessions ask for, which the bridge maps to the backend's Opus 5.5. */
const BRIDGE_MODEL = 'claude-opus-5-5';

/** The seeded profile that routes a session through the bridge, on Opus 5.5. */
export const BOISESTATE_PROFILE: LaunchProfile = {
  id: 'boisestate',
  name: 'Boise State (Opus 5.5)',
  agent: CLAUDE_CODE,
  model: BRIDGE_MODEL,
  effort: null,
  permissionMode: null,
  env: { ANTHROPIC_BASE_URL: BRIDGE_BASE_URL },
  extraArgs: [],
};

/** True when a launch env opts into the bridge through the placeholder URL. */
export function needsBridge(env: Readonly<Record<string, string>>): boolean {
  return env['ANTHROPIC_BASE_URL'] === BRIDGE_BASE_URL;
}

/** Point the env at a running sidecar: the real URL, and the token as api key. */
export function applyBridge(
  env: Readonly<Record<string, string>>,
  endpoint: BridgeEndpoint,
): Record<string, string> {
  return { ...env, ANTHROPIC_BASE_URL: endpoint.baseUrl, ANTHROPIC_API_KEY: endpoint.token };
}

/**
 * The env for a chat tab: the bridge token goes in as ANTHROPIC_AUTH_TOKEN, a
 * bearer token, since the CLI asks the user to approve every new
 * ANTHROPIC_API_KEY and the token changes each time the sidecar starts.
 */
export function bearerEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const { ANTHROPIC_API_KEY: token, ...rest } = env;
  return token === undefined ? rest : { ...rest, ANTHROPIC_AUTH_TOKEN: token };
}

/**
 * CLI args for a bridge tab: the bridge's model, and no MCP servers, since the
 * bridge sends every tool's definition as text in each request.
 */
export function chatArgs(sessionId: string): readonly string[] {
  return ['--session-id', sessionId, '--model', BRIDGE_MODEL, '--strict-mcp-config'];
}

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
