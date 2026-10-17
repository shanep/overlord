// The "why or why not loaded" resolver. It rebuilds the session's agent's
// discovery rules from its instruction policy, judges every candidate, and
// when the transcript says what actually loaded, treats that as the truth and
// explains the rest.

import { Buffer } from 'node:buffer';
import path from 'node:path';

import type { LoadedInstruction, SkippedCandidate } from '../../shared/model.js';
import { agents } from '../agents/index.js';
import type { InstructionPolicy } from '../agents/types.js';
import { encodeProjectDir } from '../paths.js';

import { collectCandidates } from './candidates.js';
import { judgeWith, type GateContext, type Load, type Skip } from './gates.js';
import { walkImports, type ImportNode } from './imports.js';
import { checkMemoryTruncation, type MemoryCut } from './memory.js';
import { expandHome } from './path-tools.js';
import { applyBudget, shadowedFiles, walkFolders, type Judged } from './policy.js';
import { DEFAULT_SCAN_LIMITS, type Candidate, type LoadMode, type ResolveInput } from './types.js';

export interface ExpectedInstruction extends LoadedInstruction {
  readonly mode: LoadMode;
  readonly detail: string;
  /** Null when nothing was observed, else whether the session showed it loaded. */
  readonly observed: boolean | null;
}

export interface ResolvedContext {
  readonly expected: readonly ExpectedInstruction[];
  readonly skipped: readonly SkippedCandidate[];
  /** Observed loads the rules did not predict. */
  readonly unexplained: readonly LoadedInstruction[];
  /** Claude's auto memory folder, or null for an agent without one. */
  readonly memoryDir: string | null;
  /** The MEMORY.md cut, when the file exists. */
  readonly memory: MemoryCut | null;
}

/** autoMemoryDirectory, then CLAUDE_CODE_PROJECT_DIR_NAME, then the git root's project dir. */
export function autoMemoryDir(input: ResolveInput): string {
  const custom = input.settings.autoMemoryDirectory;
  if (custom !== null && custom !== '') {
    return path.resolve(expandHome(custom, input.paths.home));
  }
  const named = input.settings.env['CLAUDE_CODE_PROJECT_DIR_NAME'];
  const hasConfigDir = (input.settings.env['CLAUDE_CONFIG_DIR'] ?? '') !== '';
  const project =
    hasConfigDir && named !== undefined && named !== ''
      ? named
      : encodeProjectDir(input.gitRoot ?? input.cwd);
  return path.join(input.paths.projectsDir, project, 'memory');
}

/** Files that hide others of their folder under a shadowed precedence, like CLAUDE.md. */
function shadowing(policy: InstructionPolicy, candidates: readonly Candidate[]): Candidate[] {
  const { precedence } = policy;
  if (precedence.kind !== 'shadowed') {
    return [];
  }
  return candidates.filter(
    (candidate) => candidate.exists && precedence.by.includes(candidate.kind),
  );
}

function gateContext(
  input: ResolveInput,
  policy: InstructionPolicy,
  candidates: readonly Candidate[],
): GateContext {
  const own = shadowing(policy, candidates);
  const { root } = walkFolders(policy.walk, input.cwd, input.gitRoot);
  return {
    names: policy.names,
    shadowed: shadowedFiles(policy, candidates, root),
    cwd: input.cwd,
    workDirs: [input.cwd, ...input.flags.addDirs],
    settings: input.settings,
    flags: input.flags,
    agent: input.agent,
    touched: input.touchedFiles.map((file) => path.resolve(file)),
    approvedExternalImports: input.approvedExternalImports,
    ancestorHasClaudeMd: own.some((candidate) => candidate.origin === 'ancestor'),
    nestedClaudeMdDirs: new Set(
      own
        .filter((candidate) => candidate.origin === 'nested')
        .map((candidate) => candidate.ownerDir),
    ),
  };
}

function importCandidate(root: Candidate, node: ImportNode): Candidate {
  return {
    path: node.path,
    tier: root.tier,
    kind: 'import',
    mode: 'import',
    origin: root.origin,
    ownerDir: root.ownerDir,
    exists: node.exists,
    text: node.text,
    bytes: node.text === null ? 0 : Buffer.byteLength(node.text),
    realPath: null,
    globs: [],
    parentPath: node.parentPath,
    depth: node.depth,
    inCode: node.inCode,
  };
}

interface Root {
  readonly candidate: Candidate;
  readonly text: string;
}

function importRoots(judged: readonly Judged[]): Root[] {
  const out: Root[] = [];
  for (const { candidate, verdict } of judged) {
    if (verdict.load && candidate.kind !== 'memory-index' && candidate.text !== null) {
      out.push({ candidate, text: candidate.text });
    }
  }
  return out;
}

async function expandImports(
  input: ResolveInput,
  policy: InstructionPolicy,
  judged: readonly Judged[],
  context: GateContext,
): Promise<Judged[]> {
  if (policy.imports === null) {
    return [];
  }
  const roots = importRoots(judged);
  const seen = new Set(roots.map((root) => root.candidate.path));
  const out: Judged[] = [];
  for (const { candidate, text } of roots) {
    const nodes = await walkImports(
      input.fs,
      { path: candidate.path, text },
      input.paths.home,
      seen,
    );
    for (const node of nodes) {
      // A code span that names a file that is not there is just prose.
      if (node.inCode && !node.exists) {
        continue;
      }
      const child = importCandidate(candidate, node);
      out.push({ candidate: child, verdict: judgeWith(policy.gates, child, context) });
    }
  }
  return out;
}

function toSkipped(candidate: Candidate, skip: Skip): SkippedCandidate {
  return {
    path: candidate.path,
    tier: candidate.tier,
    exists: candidate.exists,
    code: skip.code,
    detail: skip.detail,
  };
}

interface Built {
  readonly expected: ExpectedInstruction[];
  readonly skipped: SkippedCandidate[];
  readonly matched: Set<LoadedInstruction>;
  /** Observed loads that the rules said would be skipped. */
  readonly surprises: Set<LoadedInstruction>;
}

function predicted(
  candidate: Candidate,
  load: Load,
  observed: boolean | null,
): ExpectedInstruction {
  return {
    path: candidate.path,
    tier: candidate.tier,
    reason: load.reason,
    triggerPath: load.triggerPath,
    parentPath: candidate.parentPath,
    globs: candidate.globs,
    bytes: candidate.bytes,
    differsFromDisk: null,
    loadedAt: null,
    mode: candidate.mode,
    detail: load.detail,
    observed,
  };
}

function fromObserved(entry: Judged, seen: LoadedInstruction): ExpectedInstruction {
  const detail = entry.verdict.load
    ? entry.verdict.detail
    : `The session shows it loaded, although the rules predicted ${entry.verdict.code}.`;
  return {
    ...seen,
    path: entry.candidate.path,
    mode: entry.candidate.mode,
    detail,
    observed: true,
  };
}

function findObserved(
  candidate: Candidate,
  observed: ReadonlyMap<string, LoadedInstruction>,
): LoadedInstruction | undefined {
  return observed.get(candidate.path) ?? observed.get(candidate.realPath ?? candidate.path);
}

function build(entries: readonly Judged[], observedList: readonly LoadedInstruction[]): Built {
  const observed = new Map(
    observedList.map((item): [string, LoadedInstruction] => [path.resolve(item.path), item]),
  );
  const known = observedList.length > 0 ? false : null;
  const built: Built = { expected: [], skipped: [], matched: new Set(), surprises: new Set() };
  for (const entry of entries) {
    const { candidate, verdict } = entry;
    const seen = findObserved(candidate, observed);
    if (seen !== undefined) {
      built.matched.add(seen);
      if (!verdict.load) {
        built.surprises.add(seen);
      }
      built.expected.push(fromObserved(entry, seen));
    } else if (verdict.load) {
      built.expected.push(predicted(candidate, verdict, known));
    } else {
      built.skipped.push(toSkipped(candidate, verdict));
    }
  }
  return built;
}

function memoryCut(
  candidates: readonly Candidate[],
): { readonly candidate: Candidate; readonly cut: MemoryCut } | null {
  const index = candidates.find((candidate) => candidate.kind === 'memory-index');
  if (index === undefined || index.text === null) {
    return null;
  }
  return { candidate: index, cut: checkMemoryTruncation(index.text) };
}

/** Runs one instruction policy for the session. */
export async function resolveWithPolicy(
  input: ResolveInput,
  policy: InstructionPolicy,
): Promise<ResolvedContext> {
  const memoryDir = policy.autoMemory ? autoMemoryDir(input) : null;
  const candidates = await collectCandidates({
    policy,
    fs: input.fs,
    paths: input.paths,
    env: input.settings.env,
    cwd: input.cwd,
    gitRoot: input.gitRoot,
    addDirs: input.flags.addDirs,
    touchedFiles: input.touchedFiles,
    memoryDir,
    scan: input.scan ?? DEFAULT_SCAN_LIMITS,
  });
  const context = gateContext(input, policy, candidates);
  const judged = applyBudget(
    policy.budget,
    policy.names.agent,
    candidates.map((candidate): Judged => ({
      candidate,
      verdict: judgeWith(policy.gates, candidate, context),
    })),
  );
  const entries = [...judged, ...(await expandImports(input, policy, judged, context))];
  const memory = memoryCut(candidates);
  const built = build(entries, input.observedLoaded);
  const loadedPaths = new Set(built.expected.map((item) => item.path));
  // A file that loads one way (say, through an import) is not also skipped.
  const skipped = built.skipped.filter((item) => !loadedPaths.has(item.path));
  if (memory?.cut.truncated === true && loadedPaths.has(memory.candidate.path)) {
    skipped.push({
      path: memory.candidate.path,
      tier: memory.candidate.tier,
      exists: true,
      code: 'memory-truncated',
      detail: memory.cut.detail,
    });
  }
  return {
    expected: built.expected,
    skipped,
    unexplained: input.observedLoaded.filter(
      (item) => !built.matched.has(item) || built.surprises.has(item),
    ),
    memoryDir,
    memory: memory?.cut ?? null,
  };
}

/**
 * Runs the policy of the session's agent. An agent without one gets no
 * predictions, so what the session showed loaded stays unexplained.
 */
export async function resolveContext(input: ResolveInput): Promise<ResolvedContext> {
  const policy = agents.get(input.agentId)?.instructions;
  if (policy === undefined) {
    return {
      expected: [],
      skipped: [],
      unexplained: input.observedLoaded,
      memoryDir: null,
      memory: null,
    };
  }
  return resolveWithPolicy(input, policy);
}
