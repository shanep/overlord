// Every instruction file an agent could load for a session, before any
// setting or flag decides whether it does. The agent's instruction policy
// says which files to look for and in which folders.

import { Buffer } from 'node:buffer';
import path from 'node:path';

import type { MemoryTier } from '../../shared/model.js';
import type {
  InstructionEntry,
  InstructionFile,
  InstructionPolicy,
  InstructionWhere,
} from '../agents/types.js';
import type { ClaudePaths } from '../paths.js';

import { parseFrontmatter, readStringList } from './frontmatter.js';
import type { FileSystem } from './fs.js';
import { checkMemoryTruncation } from './memory.js';
import { joinUnder } from './path-tools.js';
import { walkFolders } from './policy.js';
import { listMarkdownFiles, listSubdirectories } from './scan.js';
import type { Candidate, CandidateKind, CandidateOrigin, LoadMode, ScanLimits } from './types.js';

export interface CandidateInput {
  readonly policy: InstructionPolicy;
  readonly fs: FileSystem;
  readonly paths: ClaudePaths;
  /** The session's environment, for variables that move an agent's own folder. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** The git top level holding cwd, or null outside git. */
  readonly gitRoot: string | null;
  readonly addDirs: readonly string[];
  readonly touchedFiles: readonly string[];
  /** Claude's auto memory folder, or null for an agent without one. */
  readonly memoryDir: string | null;
  readonly scan: ScanLimits;
}

interface Spec {
  readonly path: string;
  readonly tier: MemoryTier;
  readonly kind: CandidateKind;
  readonly origin: CandidateOrigin;
  readonly ownerDir: string;
  /** Mode when the file has no globs. */
  readonly mode: LoadMode;
  /** Frontmatter keys that hold a rule's globs. */
  readonly globKeys: readonly string[];
}

function rulesGlobs(text: string, keys: readonly string[]): string[] {
  const { data, error } = parseFrontmatter(text);
  // A rule whose YAML does not parse loads as if it had no globs.
  if (error !== null) {
    return [];
  }
  for (const key of keys) {
    const globs = readStringList(data[key]);
    if (globs.length > 0) {
      return globs;
    }
  }
  return [];
}

function sizeOf(kind: CandidateKind, text: string | null): number {
  if (text === null) {
    return 0;
  }
  return kind === 'memory-index' ? checkMemoryTruncation(text).keptBytes : Buffer.byteLength(text);
}

async function probe(fs: FileSystem, spec: Spec): Promise<Candidate> {
  const isFile = (await fs.kind(spec.path)) === 'file';
  const text = isFile ? await fs.readFile(spec.path) : null;
  const globs = spec.kind === 'rule' && text !== null ? rulesGlobs(text, spec.globKeys) : [];
  return {
    path: spec.path,
    tier: spec.tier,
    kind: spec.kind,
    origin: spec.origin,
    ownerDir: spec.ownerDir,
    mode: globs.length > 0 ? 'glob' : spec.mode,
    exists: isFile,
    text,
    bytes: sizeOf(spec.kind, text),
    realPath: isFile ? await fs.realpath(spec.path) : null,
    globs,
    parentPath: null,
    depth: 0,
    inCode: false,
  };
}

type Place = Pick<Spec, 'origin' | 'ownerDir' | 'mode'>;

/** A policy path like .claude/CLAUDE.md, under dir. */
export function underDir(dir: string, relative: string): string {
  return joinUnder(dir, ...relative.split('/'));
}

/** The specs one folder's entries give, in the policy's order. */
async function entrySpecs(
  fs: FileSystem,
  dir: string,
  entries: readonly InstructionEntry[],
  place: Place,
): Promise<Spec[]> {
  const out: Spec[] = [];
  for (const entry of entries) {
    if ('file' in entry) {
      if (entry.skipIn?.includes(place.origin) !== true) {
        const file = underDir(dir, entry.file);
        out.push({ ...place, path: file, tier: entry.tier, kind: entry.kind, globKeys: [] });
      }
      continue;
    }
    const rules = await listMarkdownFiles(fs, underDir(dir, entry.rules));
    for (const rule of rules.filter((name) => name.endsWith(entry.suffix))) {
      out.push({ ...place, path: rule, tier: entry.tier, kind: 'rule', globKeys: entry.globKeys });
    }
  }
  return out;
}

async function treeSpecs(
  input: CandidateInput,
  dirs: readonly string[],
  place: Omit<Place, 'ownerDir'>,
  entries: readonly InstructionEntry[] = input.policy.project,
): Promise<Spec[]> {
  const out: Spec[] = [];
  for (const dir of dirs) {
    out.push(...(await entrySpecs(input.fs, dir, entries, { ...place, ownerDir: dir })));
  }
  return out;
}

function whereOf(input: CandidateInput): InstructionWhere {
  return { home: input.paths.home, env: input.env, claude: input.paths };
}

async function outsideSpecs(input: CandidateInput): Promise<Spec[]> {
  const where = whereOf(input);
  const { managed } = input.policy;
  const eager = { ownerDir: input.cwd, mode: 'eager' } as const;
  const managedSpecs =
    managed === null
      ? []
      : await entrySpecs(input.fs, managed.dir(where), managed.entries, {
          ...eager,
          origin: 'managed',
        });
  const userSpecs = await entrySpecs(input.fs, input.policy.configDir(where), input.policy.user, {
    ...eager,
    origin: 'user',
  });
  return [...managedSpecs, ...userSpecs];
}

function memorySpecs(memoryDir: string, names: readonly string[]): Spec[] {
  const place: Omit<Spec, 'path' | 'kind'> = {
    origin: 'auto-memory',
    ownerDir: memoryDir,
    mode: 'auto-memory',
    tier: 'AutoMem',
    globKeys: [],
  };
  const index = path.join(memoryDir, 'MEMORY.md');
  const topics = names.filter((name) => name.endsWith('.md') && name !== 'MEMORY.md');
  return [
    { ...place, path: index, kind: 'memory-index' },
    ...topics.map((name): Spec => ({
      ...place,
      path: path.join(memoryDir, name),
      kind: 'memory-topic',
    })),
  ];
}

function reportedFiles(dir: string, entries: readonly InstructionEntry[]): string[] {
  return entries
    .filter((entry): entry is InstructionFile => 'file' in entry && entry.reported === true)
    .map((entry) => underDir(dir, entry.file));
}

/** Files at fixed places that are worth reporting as missing. */
function alwaysReported(input: CandidateInput): Set<string> {
  const where = whereOf(input);
  const { managed, user, project } = input.policy;
  return new Set([
    ...(managed === null ? [] : reportedFiles(managed.dir(where), managed.entries)),
    ...reportedFiles(input.policy.configDir(where), user),
    ...reportedFiles(input.cwd, project),
    ...(input.memoryDir === null ? [] : [path.join(input.memoryDir, 'MEMORY.md')]),
  ]);
}

async function projectSpecs(input: CandidateInput): Promise<Spec[]> {
  const { policy } = input;
  const walked = walkFolders(policy.walk, input.cwd, input.gitRoot);
  const eager = { origin: 'ancestor', mode: 'eager' } as const;
  const specs = [
    ...(await treeSpecs(input, walked.before, eager)),
    ...(await treeSpecs(input, walked.between, { ...eager, origin: 'between' }, policy.between)),
    ...(await treeSpecs(input, walked.after, eager)),
  ];
  if (policy.lazySubfolders) {
    const subdirectories = await listSubdirectories(
      input.fs,
      input.cwd,
      input.touchedFiles,
      input.scan,
    );
    specs.push(
      ...(await treeSpecs(input, subdirectories, { origin: 'nested', mode: 'lazy-subdir' })),
    );
  }
  if (policy.addDirs) {
    specs.push(...(await treeSpecs(input, input.addDirs, { origin: 'add-dir', mode: 'eager' })));
  }
  return specs;
}

/**
 * Every candidate in load order: managed, user, then the walked folders root
 * first, then lazy subdirectories, then --add-dir dirs, then auto memory, as
 * far as the policy has each one. A path appears once (the first place
 * wins), and only files that exist are listed, apart from the fixed
 * locations a user expects to see.
 */
export async function collectCandidates(input: CandidateInput): Promise<Candidate[]> {
  const specs: Spec[] = [...(await outsideSpecs(input)), ...(await projectSpecs(input))];
  if (input.policy.autoMemory && input.memoryDir !== null) {
    specs.push(...memorySpecs(input.memoryDir, await input.fs.readdir(input.memoryDir)));
  }
  const reported = alwaysReported(input);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const spec of specs) {
    if (seen.has(spec.path)) {
      continue;
    }
    seen.add(spec.path);
    const candidate = await probe(input.fs, spec);
    if (candidate.exists || reported.has(candidate.path)) {
      out.push(candidate);
    }
  }
  return out;
}
