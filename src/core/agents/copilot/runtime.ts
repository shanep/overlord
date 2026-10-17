// Copilot CLI in the Launcher, driven over ACP (`copilot --acp`) with the
// generic runtime in agents/acp. The @github/copilot-sdk package would hand
// back the same session events, but it pulls in a native FFI module and
// ships most weeks, and the observer already reads cost and per-call usage
// from the run's events.jsonl. So ACP alone drives it.
//
// Overlord's mode ids map onto Copilot's ACP modes. Allow all is not an ACP
// mode, so it starts Copilot with --allow-all in its agent mode. Effort has
// no ACP setting either, so it goes in as --reasoning-effort, which a real
// run showed in its session.start. The model goes through the ACP model option.

import { acpRuntime } from '../acp/runtime.js';
import type { RuntimeFacet, StartOptions } from '../shared/runtime.js';

import { COPILOT_BINARY } from './terminal.js';

const MODE_URL = 'https://agentclientprotocol.com/protocol/session-modes#';

/** Overlord's permission mode ids to Copilot's ACP mode ids. */
const MODES: Readonly<Record<string, string>> = {
  interactive: `${MODE_URL}agent`,
  plan: `${MODE_URL}plan`,
  autopilot: `${MODE_URL}autopilot`,
};

const ALLOW_ALL = 'allow-all';

const acp = acpRuntime({
  command: COPILOT_BINARY,
  // Copilot fetches a newer build on its own, which must not happen mid run.
  args: ['--acp', '--no-auto-update'],
  modes: MODES,
  // A real 1.0.89 run replied 10,596 input tokens after one turn and 21,236 after two.
  usage: 'cumulative',
});

/** The options the ACP runtime gets: effort and allow all as launch flags, the rest as they are. */
export function copilotStart(options: StartOptions): StartOptions {
  const flags: Record<string, string | null> = { ...options.extraArgs };
  if (options.effort !== null) {
    flags['reasoning-effort'] = options.effort;
  }
  const allowAll = options.permissionMode === ALLOW_ALL;
  if (allowAll) {
    flags[ALLOW_ALL] = null;
  }
  return {
    ...options,
    extraArgs: flags,
    effort: null,
    permissionMode: allowAll ? 'interactive' : options.permissionMode,
  };
}

export const copilotRuntime: RuntimeFacet = {
  ...acp,
  start: (options) => acp.start(copilotStart(options)),
};
