// Names and meanings for config kinds and sync status badges.

import type { ConfigKind, ConfigStatus } from '../../../src/shared/model.js';
import type { Tone } from '../labels.js';

export const KIND_LABELS: Readonly<Record<ConfigKind, string>> = {
  'claude-md': 'CLAUDE.md files',
  settings: 'Settings',
  rule: 'Rules',
  skill: 'Skills',
  agent: 'Agents',
  command: 'Commands',
  'output-style': 'Output styles',
  hook: 'Hooks',
  'mcp-server': 'MCP servers',
  plugin: 'Plugins',
  memory: 'Memory',
  keybindings: 'Keybindings',
};

export const KIND_ORDER: readonly ConfigKind[] = [
  'claude-md',
  'settings',
  'rule',
  'skill',
  'agent',
  'command',
  'output-style',
  'hook',
  'mcp-server',
  'plugin',
  'memory',
  'keybindings',
];

export interface StatusInfo {
  readonly label: string;
  readonly tone: Tone;
  readonly meaning: string;
}

export const STATUS_INFO: Readonly<Record<ConfigStatus, StatusInfo>> = {
  versioned: { label: 'versioned', tone: 'good', meaning: 'In the config repo, clean.' },
  modified: {
    label: 'modified',
    tone: 'warning',
    meaning: 'In the config repo with uncommitted changes.',
  },
  'external-repo': {
    label: 'external repo',
    tone: 'info',
    meaning: 'A link into another git repo.',
  },
  'local-only': { label: 'local only', tone: 'warning', meaning: 'Not versioned anywhere.' },
  'cloud-synced': { label: 'cloud synced', tone: 'info', meaning: 'Pushed from claude.ai.' },
  plugin: { label: 'plugin', tone: 'neutral', meaning: 'Provided by an installed plugin.' },
  managed: { label: 'managed', tone: 'neutral', meaning: 'From managed policy.' },
  'built-in': { label: 'built-in', tone: 'neutral', meaning: 'Ships with Claude Code.' },
  secret: {
    label: 'secret',
    tone: 'critical',
    meaning: 'Value lives in the OS keychain. The repo has a placeholder.',
  },
};

export const STATUS_ORDER: readonly ConfigStatus[] = [
  'versioned',
  'modified',
  'external-repo',
  'local-only',
  'cloud-synced',
  'plugin',
  'managed',
  'built-in',
  'secret',
];

const STATUS_SET: ReadonlySet<string> = new Set(STATUS_ORDER);

export function isConfigStatus(value: unknown): value is ConfigStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}
