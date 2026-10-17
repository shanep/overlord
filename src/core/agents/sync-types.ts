// What config sync keeps for an agent other than Claude Code, the sync part
// of ConfigFacet. Workstream E5 owns it.

import type { ConfigKind } from '../../shared/model.js';
import type { SettingsFormat } from '../knobs/facet.js';

/** A file in the agent's folder that syncs whole, linked from the config repo. */
interface SyncFile {
  readonly kind: ConfigKind;
  /** Relative to the agent's folder, with forward slashes, like "AGENTS.md". */
  readonly file: string;
}

/** A folder in the agent's folder whose entries sync one by one. */
interface SyncFolder {
  readonly kind: 'skill' | 'agent';
  /** Relative to the agent's folder, like "skills". */
  readonly dir: string;
  /** Skills are folders. Agents are files whose names end in this suffix. */
  readonly entries: 'dirs' | { readonly suffix: string };
}

/** The agent's main settings file, synced key by key and never as a whole file. */
export interface SyncSettings {
  /** Relative to the agent's folder, like "config.toml". */
  readonly file: string;
  readonly format: SettingsFormat;
  /** What the synced keys are called in the config repo, like "config.json". Always JSON. */
  readonly repoName: string;
  /** Keys that stay on this machine, past the ones the denylist always keeps out. */
  readonly local: (keyPath: readonly string[]) => boolean;
}

/** One user scope MCP server with its whole config, in the JSON shape .mcp.json uses. */
export interface SyncedMcpServer {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** Where the agent's user MCP servers live, for the config repo. Add and remove go through ConfigFacet.mcp. */
interface SyncMcp {
  /** Relative to the agent's folder. It is backed up before servers are added. */
  readonly file: string;
  /**
   * The user servers, none when the file is missing, or null when it could
   * not be read. Never throws, and reads nothing but the server entries.
   */
  read: (agentDir: string) => Promise<readonly SyncedMcpServer[] | null>;
}

/**
 * What config sync keeps in the config repo for an agent other than Claude
 * Code, under agents/<id>/. Claude Code keeps its own global/ layout.
 * Workstream E5 owns it.
 */
export interface SyncFacet {
  /** The agent's folder: ~/.copilot or $COPILOT_HOME, ~/.codex or $CODEX_HOME. */
  dir: (home: string, env: Readonly<Record<string, string | undefined>>) => string;
  readonly files: readonly SyncFile[];
  readonly folders: readonly SyncFolder[];
  readonly settings: SyncSettings | null;
  readonly mcp: SyncMcp | null;
}
