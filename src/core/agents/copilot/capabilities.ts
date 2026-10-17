// What the UI may offer for Copilot sessions. Kept apart from index.ts so the
// observer can read it without an import cycle.

import type { AgentCapabilities } from '../../../shared/agents.js';

export const COPILOT_SHORT = 'Copilot';

/**
 * Milestones 1 to 3 of META-HARNESS.md: Overlord reads Copilot sessions,
 * starts them in tabs and drives them from the Launcher over ACP.
 */
export const COPILOT_CAPABILITIES: AgentCapabilities = {
  launch: true,
  terminal: true,
  background: false,
  resume: true,
  // Copilot forks only with /fork inside its TUI, and its ACP server has no session/fork.
  fork: false,
  // A Launcher run stops its turn with session/cancel. In a tab SIGINT quits, so Esc there does it.
  interrupt: true,
  liveModelChange: false,
  livePermissionMode: false,
  // A Launcher run's session/request_permission goes to the inbox.
  approvals: true,
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
