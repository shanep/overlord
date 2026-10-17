// The instruction files GitHub Copilot CLI reads, as `copilot instruction
// list` showed them in 1.0.89: the user's copilot-instructions.md and
// instructions folder, then .github/copilot-instructions.md, AGENTS.md,
// CLAUDE.md and GEMINI.md at the git root and in cwd, with the rule files of
// .github/instructions and .claude/rules there. Of the folders between the
// git root and cwd it reads one file, the first of the nearest folder that
// has any. Folders below cwd and above the git root give nothing.

import { parseFrontmatter, readStringList } from '../../context/frontmatter.js';
import { checkMissing, checkPrecedence, type Check } from '../../context/gates.js';
import { agentHome } from '../../context/policy.js';
import type { InstructionFile, InstructionPolicy } from '../types.js';

/** Copilot reads globs from applyTo, and from paths in Claude's rule files. */
const GLOBS = ['applyTo', 'paths'];

/** The coding agent's name in excludeAgent, which the CLI also answers to. */
const EXCLUDED_AGENT = 'coding-agent';

const FILES: readonly InstructionFile[] = [
  {
    file: '.github/copilot-instructions.md',
    tier: 'Project',
    kind: 'instructions',
    reported: true,
  },
  { file: 'AGENTS.md', tier: 'Project', kind: 'agents-md', reported: true },
  { file: 'CLAUDE.md', tier: 'Project', kind: 'claude-md' },
  { file: 'GEMINI.md', tier: 'Project', kind: 'instructions' },
];

/** A file whose excludeAgent frontmatter names the coding agent stays out. */
const checkExcludeAgent: Check = (candidate) => {
  if (candidate.text === null) {
    return null;
  }
  const { data, error } = parseFrontmatter(candidate.text);
  const excluded = error === null && readStringList(data['excludeAgent']).includes(EXCLUDED_AGENT);
  return excluded
    ? {
        load: false,
        code: 'excluded',
        detail: `Its excludeAgent frontmatter names ${EXCLUDED_AGENT}, so Copilot CLI leaves it out.`,
      }
    : null;
};

export const copilotInstructions: InstructionPolicy = {
  names: { agent: 'Copilot', globKey: 'applyTo' },
  configDir: (where) => agentHome(where, 'COPILOT_HOME', '.copilot'),
  projectDir: '.github',
  user: [
    { file: 'copilot-instructions.md', tier: 'User', kind: 'instructions', reported: true },
    { rules: 'instructions', suffix: '.instructions.md', tier: 'User', globKeys: GLOBS },
  ],
  managed: null,
  walk: 'git-root-and-cwd',
  project: [
    ...FILES,
    { rules: '.github/instructions', suffix: '.instructions.md', tier: 'Project', globKeys: GLOBS },
    { rules: '.claude/rules', suffix: '.md', tier: 'Project', globKeys: GLOBS },
  ],
  between: FILES,
  lazySubfolders: false,
  addDirs: false,
  precedence: { kind: 'all' },
  budget: null,
  imports: null,
  autoMemory: false,
  gates: { base: [checkMissing], files: [checkExcludeAgent, checkPrecedence], imports: [] },
};
