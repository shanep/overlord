// The pure pieces that tie Overlord's launch flow to the boisestate.ai bridge
// sidecar. A launch profile opts in by setting ANTHROPIC_BASE_URL to the
// placeholder below; at launch time the host swaps it for the running sidecar's
// loopback URL and sets the bridge token as the api key. The host owns the
// spawn and the key, so nothing here imports vscode or touches a process.

import { z } from 'zod';

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

/** The seeded profile that routes a session through the bridge, on Opus 5.5. */
export const BOISESTATE_PROFILE: LaunchProfile = {
  id: 'boisestate',
  name: 'Boise State (Opus 5.5)',
  model: 'claude-opus-5-5',
  effort: null,
  permissionMode: null,
  env: { ANTHROPIC_BASE_URL: BRIDGE_BASE_URL },
  extraArgs: [],
};

/**
 * The system prompt a bridge session gets in place of Claude Code's own. The
 * backend runs no tools, so the session gets none either, and the tool
 * instructions that made up most of each request go away.
 */
export const BRIDGE_CHAT_PROMPT =
  'You are answering a request through the Boise State AI gateway, which runs no tools. ' +
  'You cannot read or write files, run commands or browse the web here, so put any code, ' +
  'commands or text the user needs right in your reply. Skip any instruction that only ' +
  'makes sense with tools, such as running checks, committing or reporting on the project setup.';

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
