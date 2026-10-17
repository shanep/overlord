// Claude Code as the webview pictures it before the host has said otherwise.
// Plain data, so a Node test can check it against the adapter.

import type { AgentInfo } from '../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../src/shared/agents.js';

/**
 * Claude Code as the host describes it, for a message with an empty list
 * (tests and the preview script send one). test/unit/claude-fallback.test.ts
 * keeps it in step with the adapter.
 */
export const CLAUDE_FALLBACK: AgentInfo = {
  id: CLAUDE_CODE,
  name: 'Claude Code',
  short: 'Claude',
  icon: 'sparkle',
  installed: true,
  version: null,
  capabilities: {
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
    handoffs: ['resume-local', 'open-desktop', 'teleport-local', 'remote-control'],
  },
  permissionModes: [
    { id: 'default', label: 'Default' },
    { id: 'acceptEdits', label: 'Accept edits' },
    { id: 'plan', label: 'Plan' },
    { id: 'auto', label: 'Auto' },
    { id: 'dontAsk', label: "Don't ask" },
    { id: 'bypassPermissions', label: 'Bypass permissions', risky: true },
    { id: 'manual', label: 'Manual' },
  ],
  effortLevels: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
    { id: 'max', label: 'Max' },
  ],
};
