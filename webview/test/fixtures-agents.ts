// A second agent for the tests that check what the views do once Claude Code
// is not the only one. It is sample data, not a real adapter.

import type { AgentInfo } from '../../src/shared/agents.js';
import { CLAUDE_FALLBACK } from '../src/claude-fallback.js';

export const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  short: 'Codex',
  icon: 'terminal',
  installed: true,
  version: '0.163.0',
  capabilities: {
    ...CLAUDE_FALLBACK.capabilities,
    background: false,
    interrupt: false,
    subagents: false,
    cacheReads: false,
    cacheWrites: false,
    costUsd: false,
    contextInspector: false,
    hooks: false,
    messaging: false,
    handoffs: [],
  },
  permissionModes: [
    { id: 'read-only', label: 'Read only' },
    { id: 'danger-full-access', label: 'Full access', risky: true },
  ],
  effortLevels: [],
};

export const twoAgents: readonly AgentInfo[] = [CLAUDE_FALLBACK, codexAgent];
