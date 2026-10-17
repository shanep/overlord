// Builders for resolver inputs, so each test states only what it changes.

import { CLAUDE_CODE } from '../../../shared/agents.js';
import { resolveClaudePaths, type ClaudePaths } from '../../paths.js';
import type { GateContext } from '../gates.js';
import type { Candidate, ResolveInput } from '../types.js';

import { createMemoryFs, type MemoryTree } from './memory-fs.js';

export const HOME = '/home/u';
export const CWD = '/home/u/repo';
export const PATHS: ClaudePaths = resolveClaudePaths({ home: HOME, platform: 'linux', env: {} });
export const MEMORY_DIR = '/home/u/.claude/projects/-home-u-repo/memory';

export function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    path: '/home/u/repo/CLAUDE.md',
    tier: 'Project',
    kind: 'claude-md',
    mode: 'eager',
    origin: 'ancestor',
    ownerDir: CWD,
    exists: true,
    text: 'hello',
    bytes: 5,
    realPath: '/home/u/repo/CLAUDE.md',
    globs: [],
    parentPath: null,
    depth: 0,
    inCode: false,
    ...overrides,
  };
}

export function gateContext(overrides: Partial<GateContext> = {}): GateContext {
  return {
    cwd: CWD,
    workDirs: [CWD],
    settings: {
      claudeMdExcludes: [],
      autoMemoryEnabled: null,
      autoMemoryDirectory: null,
      instructionFiles: null,
      env: {},
    },
    flags: { bare: false, safeMode: false, settingSources: null, addDirs: [] },
    agent: { isSubagent: false, omitClaudeMd: false },
    touched: [],
    approvedExternalImports: false,
    ancestorHasClaudeMd: false,
    nestedClaudeMdDirs: new Set(),
    names: { agent: 'Claude', globKey: 'paths' },
    shadowed: new Map(),
    ...overrides,
  };
}

export function resolveInput(
  tree: MemoryTree,
  overrides: Partial<ResolveInput> = {},
): ResolveInput {
  return {
    agentId: CLAUDE_CODE,
    fs: createMemoryFs(tree),
    paths: PATHS,
    cwd: CWD,
    gitRoot: CWD,
    settings: gateContext().settings,
    flags: gateContext().flags,
    agent: gateContext().agent,
    touchedFiles: [],
    observedLoaded: [],
    approvedExternalImports: false,
    ...overrides,
  };
}
