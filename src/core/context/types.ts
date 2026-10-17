// Types shared inside the context resolver. The public result types build on
// LoadedInstruction and SkippedCandidate from the shared model.

import type { AgentId } from '../../shared/agents.js';
import type { LoadedInstruction, MemoryTier, SettingsLayer } from '../../shared/model.js';
import type { ClaudePaths } from '../paths.js';

import type { FileSystem } from './fs.js';

/** Words the explanations use for an agent. */
export interface InstructionNames {
  /** As in "Loaded when Claude touched a file". */
  readonly agent: string;
  /** The frontmatter key named in "Its paths globs have not matched". */
  readonly globKey: string;
}

/** How a candidate would get into context. */
export type LoadMode = 'eager' | 'lazy-subdir' | 'glob' | 'import' | 'auto-memory';

/** instructions is any other agent's own file, like GEMINI.md or .github/copilot-instructions.md. */
export type CandidateKind =
  | 'claude-md'
  | 'local-md'
  | 'agents-md'
  | 'instructions'
  | 'rule'
  | 'import'
  | 'memory-index'
  | 'memory-topic';

/**
 * Where the candidate was found. ancestor is a folder of the walk (cwd and
 * above it), and between is a folder of Copilot's walk between the git root
 * and cwd.
 */
export type CandidateOrigin =
  'managed' | 'user' | 'ancestor' | 'between' | 'nested' | 'add-dir' | 'auto-memory';

export interface Candidate {
  readonly path: string;
  readonly tier: MemoryTier;
  readonly kind: CandidateKind;
  readonly mode: LoadMode;
  readonly origin: CandidateOrigin;
  /**
   * The directory the file belongs to: its globs are relative to it, and a
   * lazy candidate loads once Claude touches a file under it.
   */
  readonly ownerDir: string;
  readonly exists: boolean;
  readonly text: string | null;
  /** Bytes that load: the whole file, or the kept head of MEMORY.md. */
  readonly bytes: number;
  readonly realPath: string | null;
  readonly globs: readonly string[];
  /** For imports: the importing file and the hop count from the root file. */
  readonly parentPath: string | null;
  readonly depth: number;
  readonly inCode: boolean;
}

/** The value of the **Project instructions** setting (`instructionFiles`). */
export type InstructionFilesMode =
  'claude-md-or-agents-md' | 'claude-md-and-agents-md' | 'claude-md' | 'managed-only';

export type SettingSource = 'user' | 'project' | 'local';

interface ExcludeLayer {
  readonly layer: SettingsLayer;
  readonly patterns: readonly string[];
}

export interface ContextSettingsView {
  /** claudeMdExcludes from every settings layer. Arrays merge across layers. */
  readonly claudeMdExcludes: readonly ExcludeLayer[];
  readonly autoMemoryEnabled: boolean | null;
  readonly autoMemoryDirectory: string | null;
  readonly instructionFiles: InstructionFilesMode | null;
  /** The session's environment: the process env merged with settings `env` blocks. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ContextFlags {
  readonly bare: boolean;
  readonly safeMode: boolean;
  /** `--setting-sources`, or null when the flag was not passed (all sources). */
  readonly settingSources: readonly SettingSource[] | null;
  readonly addDirs: readonly string[];
}

export interface AgentView {
  readonly isSubagent: boolean;
  readonly omitClaudeMd: boolean;
}

export interface ScanLimits {
  /** Most subdirectories below cwd to visit when looking for nested files. */
  readonly maxDirs: number;
  /** Deepest level below cwd to visit. */
  readonly maxDepth: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = { maxDirs: 2000, maxDepth: 8 };

export interface ResolveInput {
  /** The session's agent, whose instruction policy the resolver runs. */
  readonly agentId: AgentId;
  readonly fs: FileSystem;
  readonly paths: ClaudePaths;
  readonly cwd: string;
  /** Main git root for the session, which keys auto memory. Null outside git. */
  readonly gitRoot: string | null;
  readonly settings: ContextSettingsView;
  readonly flags: ContextFlags;
  readonly agent: AgentView;
  /** Absolute paths the session read, wrote or edited. */
  readonly touchedFiles: readonly string[];
  /** What the transcript or hooks say loaded. Empty when unknown. */
  readonly observedLoaded: readonly LoadedInstruction[];
  /** Whether the project approved external `@` imports (the one-time dialog). */
  readonly approvedExternalImports: boolean;
  readonly scan?: ScanLimits;
}
