// What the UI may offer for Copilot sessions. Kept apart from index.ts so the
// observer can read it without an import cycle.

import type { AgentCapabilities } from '../../../shared/agents.js';

export const COPILOT_SHORT = 'Copilot';

/** Milestones 1 and 2 of META-HARNESS.md: Overlord reads Copilot sessions and starts them in tabs. */
export const COPILOT_CAPABILITIES: AgentCapabilities = {
  launch: false,
  terminal: true,
  background: false,
  resume: true,
  // Copilot forks only with /fork inside its TUI, so nothing outside can continue a copy.
  fork: false,
  // SIGINT quits the TUI, so only Esc in its tab stops a turn.
  interrupt: false,
  liveModelChange: false,
  livePermissionMode: false,
  approvals: false,
  subagents: true,
  // session.shutdown reports cache reads and writes per model.
  cacheReads: true,
  cacheWrites: true,
  // Copilot reports what it charged in nano AI units, which convert to dollars.
  costUsd: true,
  contextInspector: false,
  hooks: false,
  messaging: false,
  handoffs: ['resume-local'],
};
