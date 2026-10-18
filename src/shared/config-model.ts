// The config inventory: skills, agents, hooks and settings, where each lives and whether it is in sync.

import type { AgentId } from './agents.js';

export type ConfigKind =
  | 'claude-md'
  | 'settings'
  | 'rule'
  | 'skill'
  | 'agent'
  | 'command'
  | 'output-style'
  | 'hook'
  | 'mcp-server'
  | 'plugin'
  | 'memory'
  | 'keybindings';

export type ConfigScope =
  'managed' | 'user' | 'project' | 'local' | 'plugin' | 'built-in' | 'cloud';

export type ConfigStatus =
  | 'versioned'
  | 'modified'
  | 'external-repo'
  | 'local-only'
  | 'cloud-synced'
  | 'plugin'
  | 'managed'
  | 'built-in'
  | 'secret';

export interface ConfigItem {
  readonly id: string;
  /** The agent whose config this is. Left out for Claude Code. */
  readonly agent?: AgentId;
  readonly kind: ConfigKind;
  readonly name: string;
  readonly scope: ConfigScope;
  readonly path: string | null;
  /** Symlink target, when the path is a link. */
  readonly realPath: string | null;
  readonly status: ConfigStatus;
  readonly repo: {
    readonly root: string;
    readonly remote: string | null;
    readonly dirty: boolean;
  } | null;
}
