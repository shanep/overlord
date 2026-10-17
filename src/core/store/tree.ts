// How agents in one session hang together, for the store's views of them.

import type { AgentNode } from '../../shared/model.js';

export function byStart(left: AgentNode, right: AgentNode): number {
  return left.startedAt - right.startedAt;
}

/** Every agent below one agent in its session, at any depth. */
export function descendants(inSession: readonly AgentNode[], agentId: string): AgentNode[] {
  const found: AgentNode[] = [];
  const seen = new Set([agentId]);
  const queue = [agentId];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const node of inSession) {
      if (node.parentAgentId === parent && !seen.has(node.id)) {
        seen.add(node.id);
        found.push(node);
        queue.push(node.id);
      }
    }
  }
  return found;
}
