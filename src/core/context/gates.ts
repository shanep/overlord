// The rules that decide whether one candidate loads. Each check returns a
// skip or null, and the first skip wins, so the order below matters. The
// driver (judgeWith) and the first few checks serve every agent; the rest
// are Claude Code's, which its instruction policy lists in CLAUDE_GATES.

import type { LoadReason, MemoryTier, SettingsLayer, SkipReasonCode } from '../../shared/model.js';

import { firstMatch } from './glob.js';
import { MAX_IMPORT_HOPS } from './imports.js';
import { envOff, envOn, isInside, isInsideAny, relativePosix } from './path-tools.js';
import type {
  AgentView,
  Candidate,
  ContextFlags,
  ContextSettingsView,
  InstructionNames,
  SettingSource,
} from './types.js';

/** Claude Code skips a CLAUDE.md larger than this. */
export const MAX_INSTRUCTION_BYTES = 4 * 1024 * 1024;

export interface GateContext {
  /** The agent's words for the explanations. */
  readonly names: InstructionNames;
  readonly cwd: string;
  /** cwd and the --add-dir dirs: imports inside these are not external. */
  readonly workDirs: readonly string[];
  readonly settings: ContextSettingsView;
  readonly flags: ContextFlags;
  readonly agent: AgentView;
  readonly touched: readonly string[];
  readonly approvedExternalImports: boolean;
  /** True when cwd or an ancestor has CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md. */
  readonly ancestorHasClaudeMd: boolean;
  /** Subdirectories below cwd that have one of those three files of their own. */
  readonly nestedClaudeMdDirs: ReadonlySet<string>;
  /** Files that give way to another under the agent's precedence, by path, with why. */
  readonly shadowed: ReadonlyMap<string, string>;
}

export interface Skip {
  readonly load: false;
  readonly code: SkipReasonCode;
  readonly detail: string;
}

export interface Load {
  readonly load: true;
  readonly reason: LoadReason;
  readonly triggerPath: string | null;
  readonly detail: string;
}

export type Verdict = Skip | Load;

export type Check = (candidate: Candidate, context: GateContext) => Skip | null;

/** An agent's checks, in the order they run. */
export interface InstructionGates {
  /** Checks every file runs first, imports and memory included. */
  readonly base: readonly Check[];
  /** Checks for files the agent finds on its own. */
  readonly files: readonly Check[];
  /** Checks for imported files, which already passed their parent's. */
  readonly imports: readonly Check[];
  /** The verdict on an auto memory file, for an agent that keeps one. */
  readonly memory?: (candidate: Candidate, context: GateContext) => Verdict;
}

function skip(code: SkipReasonCode, detail: string): Skip {
  return { load: false, code, detail };
}

const LAYER_LABELS: Readonly<Record<SettingsLayer, string>> = {
  managed: 'managed settings',
  cli: '--settings',
  'project-local': 'local project settings',
  project: 'project settings',
  user: 'user settings',
  env: 'the environment',
  default: 'the defaults',
};

function isMemory(candidate: Candidate): boolean {
  return candidate.kind === 'memory-index' || candidate.kind === 'memory-topic';
}

export const checkMissing: Check = (candidate) =>
  candidate.exists ? null : skip('missing', 'The file does not exist.');

/** Skips a file that gives way to another one under the agent's precedence. */
export const checkPrecedence: Check = (candidate, context) => {
  const detail = context.shadowed.get(candidate.path);
  if (detail === undefined) {
    return null;
  }
  return skip(candidate.kind === 'agents-md' ? 'agents-md-shadowed' : 'excluded', detail);
};

const checkClaudeMdOff: Check = (candidate, context) => {
  if (envOn(context.settings.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS'])) {
    return skip(
      'claude-md-disabled',
      'CLAUDE_CODE_DISABLE_CLAUDE_MDS is set, which turns off every CLAUDE.md and auto memory file.',
    );
  }
  if (isMemory(candidate)) {
    return null;
  }
  if (context.flags.safeMode) {
    return skip(
      'claude-md-disabled',
      'The session runs with --safe-mode, which loads no CLAUDE.md files, managed ones included.',
    );
  }
  return context.flags.bare
    ? skip('claude-md-disabled', 'The session runs with --bare, which skips CLAUDE.md discovery.')
    : null;
};

const checkSize: Check = (candidate) =>
  !isMemory(candidate) && candidate.bytes > MAX_INSTRUCTION_BYTES
    ? skip('excluded', 'The file is larger than 4 MiB, so Claude Code skips it.')
    : null;

function autoMemoryOff(context: GateContext): string | null {
  const env = context.settings.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'];
  if (context.flags.safeMode) {
    return 'The session runs with --safe-mode, which turns off auto memory.';
  }
  if (envOn(env)) {
    return 'CLAUDE_CODE_DISABLE_AUTO_MEMORY is set, which turns off auto memory.';
  }
  // CLAUDE_CODE_DISABLE_AUTO_MEMORY=0 forces auto memory on over the next two.
  if (envOff(env)) {
    return null;
  }
  if (context.settings.autoMemoryEnabled === false) {
    return 'autoMemoryEnabled is false in settings, which turns off auto memory.';
  }
  return context.flags.bare ? 'The session runs with --bare, which skips auto memory.' : null;
}

function memoryVerdict(candidate: Candidate, context: GateContext): Verdict {
  const off = autoMemoryOff(context);
  if (off !== null) {
    return skip('auto-memory-disabled', off);
  }
  if (context.agent.isSubagent) {
    return skip(
      'not-passed-to-subagent',
      "Subagents do not get the main conversation's auto memory.",
    );
  }
  if (candidate.kind === 'memory-topic') {
    return skip('lazy-not-touched', 'Auto memory topic files load only when Claude reads them.');
  }
  return {
    load: true,
    reason: 'session_start',
    triggerPath: null,
    detail: 'Auto memory index, loaded at launch.',
  };
}

const checkInstructionFiles: Check = (candidate, context) => {
  const mode = context.settings.instructionFiles;
  if (mode === 'managed-only' && candidate.mode === 'eager') {
    return skip(
      'excluded',
      'Project instructions is set to managed-only, so only managed CLAUDE.md and auto memory load at launch.',
    );
  }
  return mode === 'claude-md' && candidate.kind === 'agents-md'
    ? skip('excluded', 'Project instructions is set to claude-md, so AGENTS.md is not read.')
    : null;
};

const SOURCE_FOR_TIER: Readonly<Partial<Record<MemoryTier, SettingSource>>> = {
  User: 'user',
  Project: 'project',
  Local: 'local',
};

const checkSettingSources: Check = (candidate, context) => {
  const sources = context.flags.settingSources;
  const source = SOURCE_FOR_TIER[candidate.tier];
  if (sources === null || source === undefined || sources.includes(source)) {
    return null;
  }
  return skip(
    'setting-source-excluded',
    `--setting-sources leaves out ${source}, so ${source} instruction files are skipped.`,
  );
};

const checkAddDir: Check = (candidate, context) =>
  candidate.origin === 'add-dir' &&
  !envOn(context.settings.env['CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD'])
    ? skip(
        'add-dir-without-env',
        'It sits in an --add-dir directory, which loads instruction files only with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1.',
      )
    : null;

const checkOmit: Check = (candidate, context) =>
  context.agent.isSubagent && context.agent.omitClaudeMd && candidate.mode === 'eager'
    ? skip(
        'omit-claude-md',
        'This subagent sets omitClaudeMd, so it starts without user, project and local CLAUDE.md files.',
      )
    : null;

const checkExcludes: Check = (candidate, context) => {
  if (candidate.tier === 'Managed') {
    return null;
  }
  for (const layer of context.settings.claudeMdExcludes) {
    const pattern =
      firstMatch(layer.patterns, candidate.path) ??
      firstMatch(layer.patterns, candidate.realPath ?? candidate.path);
    if (pattern !== null) {
      return skip(
        'excluded',
        `Excluded by claudeMdExcludes pattern ${pattern} in ${LAYER_LABELS[layer.layer]}.`,
      );
    }
  }
  return null;
};

const checkAgentsShadow: Check = (candidate, context) => {
  if (
    candidate.kind !== 'agents-md' ||
    context.settings.instructionFiles === 'claude-md-and-agents-md'
  ) {
    return null;
  }
  if (candidate.origin === 'nested') {
    return context.nestedClaudeMdDirs.has(candidate.ownerDir)
      ? skip(
          'agents-md-shadowed',
          'AGENTS.md is skipped because its directory has its own CLAUDE.md or CLAUDE.local.md.',
        )
      : null;
  }
  return context.ancestorHasClaudeMd
    ? skip(
        'agents-md-shadowed',
        'AGENTS.md is skipped because a CLAUDE.md or CLAUDE.local.md exists in the working directory or above it.',
      )
    : null;
};

const checkExternal: Check = (candidate, context) => {
  if (
    context.approvedExternalImports ||
    candidate.tier === 'User' ||
    candidate.tier === 'Managed'
  ) {
    return null;
  }
  if (candidate.kind === 'import' && !isInsideAny(context.workDirs, candidate.path)) {
    return skip(
      'external-import-unapproved',
      'It imports a file outside the working directory, which waits for the one-time external import approval.',
    );
  }
  const real = candidate.realPath ?? candidate.path;
  return candidate.kind === 'rule' &&
    real !== candidate.path &&
    !isInsideAny(context.workDirs, real)
    ? skip(
        'external-import-unapproved',
        'It links to a rule outside the working directory, which waits for the one-time external import approval.',
      )
    : null;
};

const checkImportShape: Check = (candidate) => {
  if (candidate.inCode) {
    return skip(
      'import-in-code',
      'The @ reference sits in a code span or fenced code block, so it is not an import.',
    );
  }
  return candidate.depth > MAX_IMPORT_HOPS
    ? skip(
        'import-too-deep',
        `It is ${String(candidate.depth)} imports deep, past the limit of ${String(MAX_IMPORT_HOPS)} hops.`,
      )
    : null;
};

/** Claude Code's checks, which its instruction policy runs. */
export const CLAUDE_GATES: InstructionGates = {
  base: [checkMissing, checkClaudeMdOff, checkSize],
  // Files Claude Code finds on its own (not imports).
  files: [
    checkInstructionFiles,
    checkSettingSources,
    checkAddDir,
    checkOmit,
    checkExcludes,
    checkAgentsShadow,
    checkExternal,
  ],
  // Imports already passed their parent's checks, so only these apply.
  imports: [checkImportShape, checkExcludes, checkExternal],
  memory: memoryVerdict,
};

function runChecks(
  checks: readonly Check[],
  candidate: Candidate,
  context: GateContext,
): Skip | null {
  for (const check of checks) {
    const result = check(candidate, context);
    if (result !== null) {
      return result;
    }
  }
  return null;
}

function triggerVerdict(candidate: Candidate, context: GateContext): Verdict {
  const base = candidate.ownerDir;
  const under = context.touched.filter((file) => isInside(base, file));
  const where = relativePosix(context.cwd, base);
  const { agent, globKey } = context.names;
  if (candidate.mode === 'lazy-subdir') {
    const trigger = under[0];
    return trigger === undefined
      ? skip('lazy-not-touched', `Only loads after ${agent} touches a file under ${where}.`)
      : {
          load: true,
          reason: 'nested_traversal',
          triggerPath: trigger,
          detail: `Loaded when ${agent} touched a file under ${where}.`,
        };
  }
  const trigger = under.find(
    (file) => firstMatch(candidate.globs, relativePosix(base, file)) !== null,
  );
  return trigger === undefined
    ? skip(
        'glob-not-matched',
        `Its ${globKey} globs (${candidate.globs.join(', ')}) have not matched a file ${agent} touched.`,
      )
    : {
        load: true,
        reason: 'path_glob_match',
        triggerPath: trigger,
        detail: `Loaded when a touched file matched its ${globKey} globs.`,
      };
}

function loadVerdict(candidate: Candidate, context: GateContext): Verdict {
  if (candidate.mode === 'lazy-subdir' || candidate.mode === 'glob') {
    return triggerVerdict(candidate, context);
  }
  if (candidate.kind === 'import') {
    return {
      load: true,
      reason: 'include',
      triggerPath: null,
      detail: 'Imported with @ by another instruction file.',
    };
  }
  return { load: true, reason: 'session_start', triggerPath: null, detail: 'Loaded at launch.' };
}

/** Runs an agent's checks on one candidate, then says how it loads. */
export function judgeWith(
  gates: InstructionGates,
  candidate: Candidate,
  context: GateContext,
): Verdict {
  const base = runChecks(gates.base, candidate, context);
  if (base !== null) {
    return base;
  }
  if (isMemory(candidate) && gates.memory !== undefined) {
    return gates.memory(candidate, context);
  }
  if (candidate.tier === 'Managed' && candidate.kind !== 'import') {
    return {
      load: true,
      reason: 'session_start',
      triggerPath: null,
      detail: 'Managed policy file, which settings cannot exclude.',
    };
  }
  const checks = candidate.kind === 'import' ? gates.imports : gates.files;
  return runChecks(checks, candidate, context) ?? loadVerdict(candidate, context);
}

/** Claude Code's verdict on one candidate. */
export function judge(candidate: Candidate, context: GateContext): Verdict {
  return judgeWith(CLAUDE_GATES, candidate, context);
}
