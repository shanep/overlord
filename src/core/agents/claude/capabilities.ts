// What the UI may offer for Claude Code sessions. Kept apart from index.ts so
// the observer can read it without an import cycle.

import type { AgentCapabilities } from '../../../shared/agents.js';
import type { HandoffKind } from '../../../shared/protocol.js';

const HANDOFFS: readonly HandoffKind[] = [
  'resume-local',
  'open-desktop',
  'teleport-local',
  'remote-control',
];

export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  launch: true,
  terminal: true,
  background: true,
  resume: true,
  fork: true,
  interrupt: true,
  liveModelChange: true,
  livePermissionMode: true,
  approvals: true,
  subagents: true,
  cacheReads: true,
  cacheWrites: true,
  costUsd: true,
  contextInspector: true,
  hooks: true,
  messaging: true,
  handoffs: HANDOFFS,
};
