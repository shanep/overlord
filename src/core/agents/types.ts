// What every agent adapter gives Overlord. An adapter fills in the facets its
// CLI supports and the UI hides the rest. Each facet below the models one is
// a first sketch that its Phase 1 workstream in META-HARNESS.md owns and may
// reshape.

import type { AgentCapabilities, AgentId, ModeOption } from '../../shared/agents.js';
import type { Connector } from '../../shared/connectors.js';
import type {
  AgentNode,
  ApiRequest,
  ContextSnapshot,
  FeedItem,
  MemoryTier,
  SessionSummary,
  ToolCall,
} from '../../shared/model.js';
import type { HandoffKind, SurfaceSession } from '../../shared/protocol.js';
import type { AgentSpec } from '../authoring/schema.js';
import type { AuthoringIssue } from '../authoring/validate.js';
import type { InstructionGates } from '../context/gates.js';
import type { CandidateKind, CandidateOrigin, InstructionNames } from '../context/types.js';
import type { EditTools, HookDialect } from '../hooks/normalized.js';
import type { KnobsFacet, SettingsFormat } from '../knobs/facet.js';
import type { TelemetryDecode } from '../otel/decode.js';
import type { ClaudePaths } from '../paths.js';
import type { Prompt } from '../reputation/prompts.js';
import type { Collected } from '../surfaces/common.js';
import type { HandoffCommand } from '../surfaces/handoff.js';
import type { AgentEntry, LiveProcess, RegistryEntry } from '../surfaces/live.js';
import type { AttachClient } from '../surfaces/places.js';
import type { ExecFunction, IsAlive } from '../surfaces/process.js';
import type { Exec } from '../sync/exec.js';
import type { SessionPeek } from '../transcripts/peek.js';
import type { ModelPrice } from '../transcripts/pricing.js';
import type { SessionMeasure } from '../tuning/measure.js';

import type { RuntimeFacet } from './shared/runtime.js';

/** The environment to look for binaries in, usually the login shell's. */
export type ShellEnv = Readonly<Record<string, string | undefined>>;

export interface DetectInput {
  readonly env: ShellEnv;
  readonly platform: NodeJS.Platform;
  /** The binary the user set for this agent, or "" for the default name. */
  readonly path: string;
}

export interface Detected {
  /** The binary to run, or null when none was found. */
  readonly bin: string | null;
  readonly version: string | null;
}

/**
 * Context windows, prices and the default model.
 * @public
 */
export interface ModelFacet {
  /** The window for a model id, or null when the model is unknown. A prompt bigger than the standard window proves a larger one. */
  contextWindow: (model: string | null, observedTokens?: number) => number | null;
  /**
   * List price per million tokens, or null when the agent has no price for
   * the model. Null means the cost is unknown, never that it is free: an
   * agent that records its own cost, or runs on a plan with no per token
   * price, returns null here.
   */
  price: (model: string) => ModelPrice | null;
  /** What the agent runs when neither a profile nor its settings pick a model. */
  readonly defaultModel: string;
}

/**
 * The agent's own names for things that advice text mentions, so Health and
 * Tuning tell a Codex user about AGENTS.md and not CLAUDE.md.
 */
export interface AgentWords {
  /** The project instruction file, such as CLAUDE.md or AGENTS.md. */
  readonly instructionsFile: string;
  /** The command that swaps the conversation for a summary, such as /compact, or null when it has none. */
  readonly compactCommand: string | null;
  /** The command that starts over with an empty context, such as /clear or /new, or null when it has none. */
  readonly clearCommand: string | null;
  /** How to go back to an earlier turn, as advice says it, such as "/rewind (or press Esc twice)". */
  readonly rewind: string | null;
}

/** The binary to run outside a terminal tab, and the login shell's environment for it. */
export interface AgentCli {
  readonly bin: string;
  readonly env: Readonly<Record<string, string>>;
}

/** What the agent's records of its running sessions are read with. */
export interface LiveSources {
  readonly paths: ClaudePaths;
  /** Throws when the command fails. */
  readonly exec: ExecFunction;
  readonly isAlive: IsAlive;
}

/** A tab that starts a session or continues one. */
export interface TerminalStart {
  /** The id a new session or a fork takes, when the agent lets Overlord pick it. */
  readonly sessionId: string;
  /** The first message, which the session starts working on at once. */
  readonly prompt: string | null;
}

interface BackgroundStart {
  readonly run: Exec;
  readonly cli: AgentCli;
  readonly cwd: string;
  /** The session to continue, or null for a new one. */
  readonly resume: string | null;
  /** Continue a copy of the resumed session under a new id. */
  readonly fork: boolean;
  /** Variables the session needs, such as its worktree's port slot. */
  readonly env: Readonly<Record<string, string>>;
  readonly prompt: string | null;
}

/** The job id a background start printed, or why it did not start. */
export type BackgroundStarted = { readonly jobId: string } | { readonly error: string };

/**
 * Detached sessions that outlive their tab, like `claude --bg`. The list uses
 * Claude Code's words for kind (background, interactive), state (working,
 * blocked, done, stopped, failed) and status (busy, idle), so another agent
 * maps its own onto them.
 */
export interface BackgroundFacet {
  start: (input: BackgroundStart) => Promise<BackgroundStarted>;
  /** Args for a tab that shows a running job. */
  attachArgs: (jobId: string) => readonly string[];
  /** The agent's jobs. With all, finished ones too. Never throws. */
  list: (input: {
    readonly exec: ExecFunction;
    readonly bin: string;
    readonly all: boolean;
  }) => Promise<Collected<AgentEntry>>;
  /** Stops a job and keeps its conversation. Resolves to null, or why it did not stop. */
  stop: (input: {
    readonly run: Exec;
    readonly cli: AgentCli;
    readonly jobId: string;
  }) => Promise<string | null>;
  /** The clients showing a job, from `ps -A -o pid=,ppid=,args=`. */
  attachClients: (ps: string) => readonly AttachClient[];
}

/**
 * Terminal tabs, background runs, the agent's own list of running sessions,
 * and the handoffs to its other apps. Workstream B owns it.
 * @public
 */
export interface TerminalFacet {
  /** The binary's name when the user has not set a path. */
  readonly command: string;
  /** True when a new session takes the id newArgs passes, so a tab is tied to it at once. */
  readonly presetId: boolean;
  newArgs: (start: TerminalStart) => readonly string[];
  /** Args to continue sessionId, or with fork a copy of it under start.sessionId. */
  resumeArgs: (sessionId: string, fork: boolean, start: TerminalStart) => readonly string[];
  readonly background?: BackgroundFacet;
  /** What interrupts a turn of a session in a plain terminal, or null when only its tab can. */
  readonly interruptSignal: NodeJS.Signals | null;
  /** A tab title for something the agent runs, such as "Claude 8c3efb13". */
  tabName: (label: string) => string;
  /** The live sessions the agent records on this machine, for where each one runs. */
  registry?: (sources: LiveSources) => Promise<Collected<RegistryEntry>>;
  /** The live process holding a session, from every record the agent keeps. */
  findLive: (
    sources: LiveSources & { readonly bin: string },
    sessionId: string,
  ) => Promise<LiveProcess | undefined>;
  /** The command for a handoff to another of the agent's apps, or null when it does not apply. */
  handoff?: (kind: HandoffKind, session: SurfaceSession, bin: string) => HandoffCommand | null;
}

/** Where an agent's observer looks for files. */
export interface ObserverContext {
  readonly home: string;
  /** Variables that move an agent's folders, like CLAUDE_CONFIG_DIR or CODEX_HOME. */
  readonly env: ShellEnv;
  /** Claude Code's folders as the app resolved them. Only the Claude observer reads these. */
  readonly claude: ClaudePaths;
}

/** One session as a scan of the agent's folders found it. */
export interface ObservedSession {
  readonly sessionId: string;
  /** The file that holds the main thread's records. */
  readonly transcriptPath: string;
  /** Latest write to any of the session's files, compared with the active and idle windows. */
  readonly mtimeMs: number;
  /** Size of the main file in bytes. */
  readonly size: number;
}

/** A file the watcher tails for a session. */
export interface TailedFile {
  readonly path: string;
  /** The thread its records belong to. The main file uses the session id. */
  readonly agentId: string;
  /** A file that describes the thread, such as Claude's agent-<id>.meta.json, or null. */
  readonly metaPath: string | null;
}

/** What one record added, for the bus. */
export interface RecordDelta {
  readonly agentId: string;
  readonly tools: readonly ToolCall[];
  readonly requests: readonly ApiRequest[];
  readonly feed: readonly FeedItem[];
  readonly contextChanged: boolean;
  /** When the thread compacted, in ms. */
  readonly compactions: readonly number[];
}

/** Folds one session's records, from every file it has, into the shared model. */
export interface RecordAccumulator {
  /** Reads one line from a file of thread agentId. Null when the line is not a record it reads. */
  ingest: (line: string, agentId: string) => RecordDelta | null;
  summary: (now: number) => SessionSummary;
  /** The main thread first. */
  agents: (now: number) => readonly AgentNode[];
  /** True while a turn is open, so an idle session is not dropped mid-turn. */
  busy: () => boolean;
  /** What the records show about a thread's context. Left out when the agent's files do not say. */
  observedContext?: (agentId: string) => ContextSnapshot;
  /** Runs before each read of a file, for example to pick up its meta file. */
  prepare?: (file: TailedFile) => Promise<void>;
}

/** Title, folder and branch for the all-sessions list, read cheaply. */
export type PeekReader = (session: ObservedSession) => Promise<SessionPeek>;

export interface ObserverListInput {
  /** What the fleet already knows about live sessions, by id. */
  readonly known: ReadonlyMap<string, SessionSummary>;
  /** Peeks through the app's cache, so a file is read again only after it changes. */
  readonly peek: (session: ObservedSession, read: PeekReader) => Promise<SessionPeek>;
  readonly report: (message: string) => void;
}

/** The agent's files as one app sees them. TailingWatcher runs any of these. */
export interface SessionObserver<A extends RecordAccumulator = RecordAccumulator> {
  /** Names the source in errors, for example "transcripts". */
  readonly source: string;
  /** The folder fs.watch follows, or null to rely on polling alone. */
  readonly watchRoot: string | null;
  /** Every session on disk, newest first, from file metadata alone. */
  scan: () => Promise<readonly ObservedSession[]>;
  /** Files past the main one, such as subagent transcripts. Asked again on every read. */
  childFiles: (session: ObservedSession) => Promise<readonly TailedFile[]>;
  makeAccumulator: (session: ObservedSession) => A;
  /** Rows for the all-sessions list. Left out when the agent has no history to list. */
  list?: (input: ObserverListInput) => Promise<readonly SurfaceSession[]>;
}

/** A file that holds prompts the user typed, for Reputation. */
export interface PromptFile {
  readonly path: string;
  /** Null for a file that is not there right now, such as a history file not written yet. */
  readonly stamp: { readonly mtimeMs: number; readonly size: number } | null;
  /**
   * A session's own file, which names the session, or a history file that
   * keeps prompts from many sessions after their transcripts are gone.
   */
  readonly kind: 'transcript' | 'history';
  /** The session a transcript belongs to. Null for a history file. */
  readonly sessionId: string | null;
}

/** What one prompt file holds. */
export interface PromptFileRead {
  readonly prompts: readonly Prompt[];
  /** The session's title, for a transcript that has one. */
  readonly title: string | null;
}

/** Where the agent keeps what the user typed. Reputation reads these. */
export interface UserPrompts {
  /** Every prompt file. A history file that is missing is still listed, with a null stamp, so its old stamp is kept. */
  files: () => Promise<readonly PromptFile[]>;
  /** Reads one file. Called only when its stamp changed since the last scan. */
  read: (file: PromptFile) => Promise<PromptFileRead>;
}

/**
 * Sessions the agent ran without Overlord, read from its own files.
 * @public
 */
export interface ObserverFacet {
  create: (context: ObserverContext) => SessionObserver;
  /** The prompts the user typed, for Reputation. Left out when the agent's files do not keep them. */
  userPrompts?: (context: ObserverContext) => UserPrompts;
}

/** One session's files as the Tuning scan sees them. */
export interface TuningSession {
  readonly sessionId: string;
  /** The main file, which keys the session in the Tuning index. */
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * Reads the agent's past sessions for the Tuning view. Each agent parses its
 * own denial text, model ids and cache fields, and the rules and totals are
 * shared.
 */
export interface TuningFacet {
  /** Every session on disk, from file metadata alone. */
  sessions: (context: ObserverContext) => Promise<readonly TuningSession[]>;
  /** Reads one session's files and measures them. */
  measure: (session: TuningSession) => Promise<SessionMeasure>;
  /** The knobs a tip's advice sets, by tip id, for an agent whose knobs differ from Claude Code's. */
  readonly knobs?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Where the app found an agent's files, so a facet can be pointed at a temp
 * folder in tests.
 */
export interface AgentDirs {
  readonly home: string;
  /** The agent's config folder: ~/.claude or CLAUDE_CONFIG_DIR, ~/.copilot, ~/.codex or CODEX_HOME. */
  readonly configDir: string;
}

interface HookInstallResult {
  /** False when the file already said the same thing. */
  readonly changed: boolean;
}

/**
 * Installs the agent's hooks, reads what they send and writes the answer.
 * Workstream D owns it.
 */
export interface HooksFacet extends HookDialect {
  /** Adds the hook command to every event Overlord listens to and keeps the user's own hooks. */
  install: (dirs: AgentDirs, command: string) => Promise<HookInstallResult>;
  uninstall: (dirs: AgentDirs) => Promise<HookInstallResult>;
  /** True when any event runs Overlord's hook command. */
  installed: (dirs: AgentDirs) => Promise<boolean>;
  /**
   * Tools that write files, each with the input fields that can hold the
   * path, tried in order. The coordinator watches these for edits.
   */
  readonly editTools: EditTools;
}

export type SettingsWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Turns on the agent's OTLP export and reads what it sends. The receiver and
 * the join of span timings onto requests are shared. Workstream D owns it.
 */
export interface TelemetryFacet {
  /** Points the agent's export at the receiver on 127.0.0.1:port. Prompts and tool details stay off. */
  enable: (dirs: AgentDirs, port: number) => Promise<SettingsWriteResult>;
  disable: (dirs: AgentDirs) => Promise<SettingsWriteResult>;
  /** Records from one export body, or null when it is not valid OTLP. */
  readonly decode: TelemetryDecode;
}

/** The ways Overlord's text can reach a session. */
export type InjectRoute = 'hook' | 'launch-argument' | 'first-prompt';

/**
 * Best first. A hook answer reaches every session, Overlord's or not, at the
 * moment it matters. A launch argument only reaches sessions Overlord starts.
 * A first prompt prefix is the last resort, since it shows up in the
 * transcript as if the user typed it.
 */
export const INJECT_ORDER: readonly InjectRoute[] = ['hook', 'launch-argument', 'first-prompt'];

/**
 * How coordination notes, the launch check and the connector briefing reach
 * a session. Workstream D owns it.
 */
export interface InjectFacet {
  /** The routes the agent takes, in INJECT_ORDER. */
  readonly routes: readonly InjectRoute[];
  /** Arguments that add text to a new session's instructions. */
  readonly launchArgs?: (text: string) => readonly string[];
  /** The first prompt with Overlord's text in front of it. */
  readonly promptPrefix?: (text: string, prompt: string) => string;
}

/**
 * The best route for a session. A hook only counts while the agent's hooks
 * are installed, and the other two only when Overlord starts the session.
 */
export function injectRoute(
  facet: InjectFacet,
  usable: { readonly hooks: boolean; readonly launching: boolean },
): InjectRoute | null {
  const allowed = (route: InjectRoute): boolean => {
    if (route === 'hook') {
      return usable.hooks;
    }
    const supported =
      route === 'launch-argument'
        ? facet.launchArgs !== undefined
        : facet.promptPrefix !== undefined;
    return usable.launching && supported;
  };
  return INJECT_ORDER.find((route) => facet.routes.includes(route) && allowed(route)) ?? null;
}

/** Where an agent keeps its own files, for its instruction policy. */
export interface InstructionWhere {
  readonly home: string;
  /** The session's environment, for variables like CODEX_HOME or COPILOT_HOME. */
  readonly env: ShellEnv;
  /** Claude Code's folders as the app resolved them. Only the Claude policy reads these. */
  readonly claude: ClaudePaths;
}

/** One file an agent looks for in a folder. */
export interface InstructionFile {
  /** The path relative to the folder, with forward slashes, like .claude/CLAUDE.md. */
  readonly file: string;
  readonly tier: MemoryTier;
  readonly kind: CandidateKind;
  /** Listed as missing when it is not there, in the working directory or the agent's own folder. */
  readonly reported?: boolean;
  /** Folders of these origins do not have it, like AGENTS.md in a Claude --add-dir folder. */
  readonly skipIn?: readonly CandidateOrigin[];
}

/**
 * A folder of rule files, searched all the way down. A rule with globs in
 * its frontmatter loads once a file the session touched matches one, and a
 * rule without them loads at launch.
 */
interface InstructionRules {
  /** The folder relative to the one walked, with forward slashes, like .claude/rules. */
  readonly rules: string;
  /** The end of a rule's file name, like .md or .instructions.md. */
  readonly suffix: string;
  readonly tier: MemoryTier;
  /** Frontmatter keys that hold the globs, tried in order: Claude's paths, Copilot's applyTo. */
  readonly globKeys: readonly string[];
}

export type InstructionEntry = InstructionFile | InstructionRules;

/**
 * The folders an agent reads project files from.
 * - root-to-cwd: every folder from the file system root down to cwd (Claude).
 * - git-root-to-cwd: every folder from the git root down to cwd, or cwd alone
 *   outside git (Codex).
 * - git-root-and-cwd: the git root and cwd, plus the `between` files of the
 *   nearest folder between them that has one (Copilot).
 */
type InstructionWalk = 'root-to-cwd' | 'git-root-to-cwd' | 'git-root-and-cwd';

/**
 * Which file wins when a folder has more than one.
 * - all: every file loads, apart from what the gates skip.
 * - first-per-folder: only the first file found in a folder loads, like
 *   Codex reading AGENTS.override.md instead of AGENTS.md.
 * - shadowed: files of one kind give way when the folder has one of another,
 *   like Claude skipping AGENTS.md next to a CLAUDE.md. The agent's gates
 *   apply it, since a setting can turn it off.
 */
type InstructionPrecedence =
  | { readonly kind: 'all' }
  | { readonly kind: 'first-per-folder' }
  | {
      readonly kind: 'shadowed';
      readonly shadowed: readonly CandidateKind[];
      readonly by: readonly CandidateKind[];
    };

/** A cap on the project files together, like Codex's project_doc_max_bytes. */
export interface InstructionBudget {
  readonly bytes: number;
  /** The setting that changes it, named in the explanation. */
  readonly setting: string;
}

/** Files an administrator puts in place, which no setting turns off. */
interface ManagedInstructions {
  readonly dir: (where: InstructionWhere) => string;
  readonly entries: readonly InstructionFile[];
}

/**
 * Which instruction files an agent reads and what decides whether each one
 * loads. The walk, glob, import and scan engine in src/core/context is
 * shared, and this is the data it runs on. Workstream E1 owns it.
 */
export interface InstructionPolicy {
  readonly names: InstructionNames;
  /** The agent's own folder, which holds its user files: ~/.claude, ~/.codex or ~/.copilot. */
  readonly configDir: (where: InstructionWhere) => string;
  /** The agent's folder in a repository, like .claude, which the launch check leaves out of its ignored files. */
  readonly projectDir: string;
  /** Files in the agent's own folder, read in every project. */
  readonly user: readonly InstructionEntry[];
  /** Null when the agent has no managed files. */
  readonly managed: ManagedInstructions | null;
  readonly walk: InstructionWalk;
  /** Files read in each folder the walk visits, in load order. */
  readonly project: readonly InstructionEntry[];
  /** For git-root-and-cwd: the files of the nearest folder between the two, of which the first found loads. */
  readonly between: readonly InstructionFile[];
  /** True when folders below cwd load their project files once the session touches a file in them. */
  readonly lazySubfolders: boolean;
  /** True when --add-dir folders have project files of their own. */
  readonly addDirs: boolean;
  readonly precedence: InstructionPrecedence;
  /** A cap on the project files together, or null. The file that crosses it is cut and the rest are skipped. */
  readonly budget: InstructionBudget | null;
  /** How a file pulls in others: '@path' references (Claude), or null when it cannot. */
  readonly imports: 'at-path' | null;
  /** True when the agent keeps auto memory in Claude's projects folder. */
  readonly autoMemory: boolean;
  /** The checks that decide whether one file loads. */
  readonly gates: InstructionGates;
}

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
export interface McpPlace extends ObserverContext {
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
export interface LibraryPlace extends ObserverContext {
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

/**
 * Settings layers, knobs, MCP servers and skills. Workstreams E2 to E5 own it.
 * @public
 */
export interface ConfigFacet {
  /** The format of the agent's main settings file. */
  readonly settingsFormat: SettingsFormat;
  /** Knob catalog, settings layers and precedence, and launch overrides. Workstream E2 owns it. */
  readonly knobs?: KnobsFacet;
  /** The agent's MCP servers. Workstream E3 owns it. */
  readonly mcp?: McpStore;
  /** The agent's skill folders and custom agent files. Workstream E4 owns it. */
  readonly library?: LibraryFacet;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly name: string;
  readonly short: string;
  /** A codicon id. */
  readonly icon: string;
  detect: (input: DetectInput) => Promise<Detected>;
  readonly capabilities: AgentCapabilities;
  readonly modes: {
    readonly permission: readonly ModeOption[];
    readonly effort: readonly ModeOption[];
  };
  readonly models: ModelFacet;
  /** Names advice text uses. Left out, Health and Tuning use plain words and skip the advice that needs a command. */
  readonly words?: AgentWords;
  readonly runtime?: RuntimeFacet;
  readonly terminal?: TerminalFacet;
  readonly observer?: ObserverFacet;
  readonly hooks?: HooksFacet;
  readonly telemetry?: TelemetryFacet;
  readonly inject?: InjectFacet;
  readonly instructions?: InstructionPolicy;
  readonly config?: ConfigFacet;
  readonly tuning?: TuningFacet;
}
