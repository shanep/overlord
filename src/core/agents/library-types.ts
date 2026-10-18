// An agent's MCP servers, skills and custom agent files.

import type { Connector } from '../../shared/connectors.js';
import type { AgentSpec } from '../authoring/schema.js';
import type { AuthoringIssue } from '../authoring/validate.js';
import type { Exec } from '../sync/exec.js';

import type { AgentCli } from './launch-types.js';
import type { AgentPlace } from './place-types.js';
import type { SettingsWriteResult } from './talk-types.js';

/**
 * Where a server is set up. User servers reach every project, project ones
 * come from a file in the folder, and local ones are kept for one folder
 * outside it, like Claude Code's `--scope local`.
 */
export type McpScope = 'user' | 'project' | 'local';

/** A server as add takes it: the shape `claude mcp add-json` reads. */
export type McpServerConfig =
  | {
      readonly type: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'http' | 'sse';
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

/** One server as the agent's own files set it up. */
export interface McpServer {
  readonly name: string;
  readonly scope: McpScope;
  /** The file it came from. */
  readonly file: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  /** The command line or the URL. */
  readonly target: string;
  /** Pending waits for the user to approve a project file's server, off is turned off. */
  readonly state: 'on' | 'pending' | 'off';
}

/** What the agent's MCP files hold, with a line for each file that would not parse. */
export interface McpRead {
  readonly servers: readonly McpServer[];
  readonly errors: readonly string[];
}

/** Where to look for an agent's MCP files. */
export interface McpPlace extends AgentPlace {
  /** The folder whose project servers count, or null for user servers alone. */
  readonly cwd: string | null;
}

/** What add and remove run the agent's CLI with. */
export interface McpWrite {
  readonly exec: Exec;
  readonly cli: AgentCli;
  /** Where the CLI runs, which decides the folder a project or local scope means. */
  readonly cwd: string;
}

/**
 * An agent's MCP servers. List reads the agent's files directly and adds only
 * what its CLI knows beyond them, such as health. Add and remove go through
 * the agent's own CLI, so the agent writes its own file. Workstream E3 owns it.
 */
export interface McpStore {
  /** The scopes add takes, the one the registry browser uses first. */
  readonly scopes: readonly McpScope[];
  /** The servers in the agent's files. Never runs the agent and never throws. */
  read: (place: McpPlace) => Promise<McpRead>;
  /** Rows for the Connectors view and the session briefing. Never throws. */
  list: (input: McpWrite & { readonly place: McpPlace }) => Promise<Connector[]>;
  add: (
    input: McpWrite & {
      readonly name: string;
      readonly server: McpServerConfig;
      readonly scope: McpScope;
    },
  ) => Promise<SettingsWriteResult>;
  remove: (
    input: McpWrite & { readonly name: string; readonly scope: McpScope },
  ) => Promise<SettingsWriteResult>;
  /** Args that sign in to a server in a terminal, left out when the agent has no such command. */
  readonly signInArgs?: (name: string) => readonly string[];
}

/** Where a folder of skills or agent files applies. */
export type LibraryScope = 'managed' | 'user' | 'project' | 'plugin';

/** One folder an agent reads skills or agent files from. */
export interface LibraryFolder {
  readonly dir: string;
  readonly scope: LibraryScope;
  /** Goes before the name of everything in the folder, like a plugin's "name:". Empty for none. */
  readonly prefix: string;
  /** False for folders an administrator or a plugin fills, which Overlord never writes. */
  readonly writable: boolean;
}

/** Where to look for an agent's skill and agent folders. */
export interface LibraryPlace extends AgentPlace {
  /** The project folder, or null for the user folders alone. */
  readonly cwd: string | null;
  /** The git root above cwd, or null outside git. */
  readonly gitRoot: string | null;
  /** Installed plugins, for an agent that reads skills from them. */
  readonly plugins: readonly { readonly name: string; readonly root: string }[];
}

/**
 * The /overlord skill that moves a running session into Overlord, for an
 * agent whose sessions Overlord can continue in a tab.
 */
export interface TransferSkill {
  /** The user folder it goes in, as <folder>/overlord/SKILL.md. */
  readonly folder: (place: LibraryPlace) => string;
  /** The skill's text. The link ends in "session=", and the skill puts the session id after it. */
  readonly text: (link: string) => string;
}

/**
 * The folders an agent reads SKILL.md skills from, and how it lists them.
 * Every agent reads the same SKILL.md format, so the schema is shared.
 */
export interface SkillsFacet {
  /** Folders of <name>/SKILL.md, highest precedence first. */
  folders: (place: LibraryPlace) => readonly LibraryFolder[];
  /**
   * The skill folder inside a project folder that --add-dir folders and
   * folders below cwd have, like .claude/skills. Null when the agent reads
   * neither.
   */
  readonly nested: string | null;
  /** True when skills synced from claude.ai sit in the user folder's synced folder. */
  readonly synced: boolean;
  /** True when one name is one skill and the highest folder wins. False when the agent lists every copy. */
  readonly ranked: boolean;
  /** Folder names the agent skips outside plugins, in lower case. One ending in ":" is a prefix. */
  readonly reserved: readonly string[];
  /** The frontmatter key that keeps a skill out of the listing until the user runs it, or null. */
  readonly manualOnly: string | null;
  /** The variable that turns managed skills off, or null. */
  readonly managedOffEnv: string | null;
  /** The listing cuts description plus when_to_use at this many characters, or null. */
  readonly listingLimit: number | null;
  readonly transfer?: TransferSkill;
}

/**
 * An agent's custom agent files: where they live and their format. Formats
 * differ per agent (Claude's .md, Copilot's .agent.md, Codex's .toml), so
 * each adapter brings its own schema.
 */
export interface AgentFilesFacet {
  /** The end of a file name, like .md, .agent.md or .toml. */
  readonly suffix: string;
  /** Folders of agent files, highest precedence first. */
  folders: (place: LibraryPlace) => readonly LibraryFolder[];
  /** The agent's name for a file, from its text or else its file name. */
  nameOf: (text: string, file: string) => string;
  validate: (text: string) => readonly AuthoringIssue[];
  /** A template in this agent's format. Templates use Claude Code's fields, which each agent maps onto its own. */
  render: (spec: AgentSpec) => string;
  /** The file text with its name set. A draft that does not parse comes back as it is. */
  withName: (text: string, name: string) => string;
  /**
   * What the drafting prompt tells Claude about the file. The reply always
   * opens with YAML frontmatter, so an agent whose files are not Markdown
   * turns it into its own format in withName.
   */
  readonly guide: string;
}

/** The agent's skills and custom agents. Workstream E4 owns it. */
export interface LibraryFacet {
  readonly skills?: SkillsFacet;
  readonly agents?: AgentFilesFacet;
}
