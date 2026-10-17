// Which parts of the help page the known agents need. A section about
// something only some agents can do, such as Claude Code's background jobs
// or the handoff buttons, shows only when a known agent can do it.

import type { AgentInfo } from '../../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../../src/shared/agents.js';
import type { Surface } from '../../../src/shared/model.js';
import type { HandoffKind } from '../../../src/shared/protocol.js';
import { findAgent, knowsClaude } from '../agents.js';
import { SURFACES } from '../labels.js';

import { CLAUDE_SESSIONS_ID } from './help-agents.js';

/** The id of the handoff buttons section. */
export const HANDOFFS_ID = 'help-handoffs';

const HANDOFFS: readonly HandoffKind[] = [
  'resume-local',
  'open-desktop',
  'teleport-local',
  'remote-control',
];

/** Surfaces only the Claude adapter ever sets. */
const CLAUDE_SURFACES: ReadonlySet<Surface> = new Set([
  'desktop-code',
  'cowork',
  'cloud',
  'claude-ai',
]);

/** The handoffs at least one known agent offers, in page order. */
export function offeredHandoffs(agents: readonly AgentInfo[]): readonly HandoffKind[] {
  const offered = new Set(agents.flatMap((agent) => agent.capabilities.handoffs));
  return HANDOFFS.filter((kind) => offered.has(kind));
}

/** The surfaces worth explaining: the Claude products only when Claude Code is known. */
export function shownSurfaces(agents: readonly AgentInfo[]): readonly Surface[] {
  const claude = knowsClaude(agents);
  return SURFACES.filter((surface) => claude || !CLAUDE_SURFACES.has(surface));
}

/** The ids of the sections no known agent needs, so the page and its contents leave them out. */
export function skippedSections(agents: readonly AgentInfo[]): ReadonlySet<string> {
  const skipped = new Set<string>();
  if (!knowsClaude(agents) || !findAgent(agents, CLAUDE_CODE).capabilities.background) {
    skipped.add(CLAUDE_SESSIONS_ID);
  }
  if (offeredHandoffs(agents).length === 0) {
    skipped.add(HANDOFFS_ID);
  }
  return skipped;
}

/** "Claude Code, Codex CLI and Copilot CLI". */
export function agentNames(agents: readonly AgentInfo[]): string {
  const names = agents.map((agent) => agent.name);
  const last = names.pop() ?? '';
  return names.length === 0 ? last : `${names.join(', ')} and ${last}`;
}
