// The instruction files Codex CLI reads. In its own folder (CODEX_HOME or
// ~/.codex) it reads AGENTS.override.md, or AGENTS.md when there is no
// override. Then, in each folder from the git root down to cwd (cwd alone
// outside git), it reads the first of AGENTS.override.md, AGENTS.md and the
// project_doc_fallback_filenames, one file per folder. The project files
// together stop at project_doc_max_bytes: the file that crosses it is cut,
// and later ones are left out.

import { checkMissing, checkPrecedence } from '../../context/gates.js';
import { agentHome } from '../../context/policy.js';
import type { InstructionFile, InstructionPolicy } from '../types.js';

/** Codex's default project_doc_max_bytes. */
const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

/** The two settings in config.toml that change what Codex reads. */
export interface CodexProjectFiles {
  /** project_doc_max_bytes. */
  readonly maxBytes?: number;
  /** project_doc_fallback_filenames, tried after AGENTS.md in each folder. */
  readonly fallbackFilenames?: readonly string[];
}

/** Codex's policy under the given config.toml settings. */
export function codexInstructionPolicy(settings: CodexProjectFiles = {}): InstructionPolicy {
  const fallbacks = settings.fallbackFilenames ?? [];
  return {
    names: { agent: 'Codex', globKey: 'paths' },
    configDir: (where) => agentHome(where, 'CODEX_HOME', '.codex'),
    projectDir: '.codex',
    user: [
      { file: 'AGENTS.override.md', tier: 'User', kind: 'agents-md' },
      { file: 'AGENTS.md', tier: 'User', kind: 'agents-md', reported: true },
    ],
    managed: null,
    walk: 'git-root-to-cwd',
    project: [
      { file: 'AGENTS.override.md', tier: 'Project', kind: 'agents-md' },
      { file: 'AGENTS.md', tier: 'Project', kind: 'agents-md', reported: true },
      ...fallbacks.map((file): InstructionFile => ({
        file,
        tier: 'Project',
        kind: 'instructions',
      })),
    ],
    between: [],
    lazySubfolders: false,
    addDirs: false,
    precedence: { kind: 'first-per-folder' },
    budget: {
      bytes: settings.maxBytes ?? CODEX_PROJECT_DOC_MAX_BYTES,
      setting: 'project_doc_max_bytes',
    },
    imports: null,
    autoMemory: false,
    gates: { base: [checkMissing], files: [checkPrecedence], imports: [] },
  };
}

/** Codex's policy with the default settings. */
export const codexInstructions: InstructionPolicy = codexInstructionPolicy();
