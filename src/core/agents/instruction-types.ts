// Which instruction files an agent loads, from where, and in what order.

import type { MemoryTier } from '../../shared/model.js';
import type { InstructionGates } from '../context/gates.js';
import type { CandidateKind, CandidateOrigin, InstructionNames } from '../context/types.js';

import type { AgentPlace } from './place-types.js';

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
  readonly dir: (where: AgentPlace) => string;
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
  readonly configDir: (where: AgentPlace) => string;
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
