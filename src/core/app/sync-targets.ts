// The agents past Claude Code whose config syncs, pointed at this machine's
// folders. Each adapter opts in with a sync part on its config facet.

import { agents } from '../agents/index.js';
import { agentSyncTargets, type AgentSyncTarget } from '../sync/agent-plan.js';

import type { Runtime } from './runtime.js';

export function syncTargets(rt: Pick<Runtime, 'paths' | 'env'>): AgentSyncTarget[] {
  return agentSyncTargets(agents.list(), rt.paths.home, rt.env);
}
