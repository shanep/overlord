// The instruction files Claude Code reads. Its checks stay in
// context/gates.ts, where the shared engine runs them.

import { CLAUDE_GATES } from '../../context/gates.js';
import type { InstructionEntry, InstructionPolicy } from '../types.js';

const RULES = ['paths'];

/** CLAUDE.md, .claude/CLAUDE.md, rules and CLAUDE.local.md of one folder, then AGENTS.md. */
const PROJECT: readonly InstructionEntry[] = [
  { file: 'CLAUDE.md', tier: 'Project', kind: 'claude-md', reported: true },
  { file: '.claude/CLAUDE.md', tier: 'Project', kind: 'claude-md', reported: true },
  { rules: '.claude/rules', suffix: '.md', tier: 'Project', globKeys: RULES },
  { file: 'CLAUDE.local.md', tier: 'Local', kind: 'local-md', reported: true },
  // An --add-dir folder never gives AGENTS.md.
  { file: 'AGENTS.md', tier: 'Project', kind: 'agents-md', skipIn: ['add-dir'] },
  { file: '.claude/AGENTS.md', tier: 'Project', kind: 'agents-md', skipIn: ['add-dir'] },
];

export const claudeInstructions: InstructionPolicy = {
  names: { agent: 'Claude', globKey: 'paths' },
  configDir: (where) => where.claude.configDir,
  projectDir: '.claude',
  user: [
    { file: 'CLAUDE.md', tier: 'User', kind: 'claude-md', reported: true },
    { rules: 'rules', suffix: '.md', tier: 'User', globKeys: RULES },
  ],
  managed: {
    dir: (where) => where.claude.managedDir,
    entries: [{ file: 'CLAUDE.md', tier: 'Managed', kind: 'claude-md', reported: true }],
  },
  walk: 'root-to-cwd',
  project: PROJECT,
  between: [],
  lazySubfolders: true,
  addDirs: true,
  // A CLAUDE.md or CLAUDE.local.md hides AGENTS.md. checkAgentsShadow applies it.
  precedence: { kind: 'shadowed', shadowed: ['agents-md'], by: ['claude-md', 'local-md'] },
  budget: null,
  imports: 'at-path',
  autoMemory: true,
  gates: CLAUDE_GATES,
};
