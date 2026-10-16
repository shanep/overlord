// Every instruction file Claude Code could load for a session, before any
// setting or flag decides whether it does.

import { Buffer } from 'node:buffer';
import path from 'node:path';

import type { MemoryTier } from '../../shared/model.js';
import type { ClaudePaths } from '../paths.js';

import { parseFrontmatter, readStringList } from './frontmatter.js';
import type { FileSystem } from './fs.js';
import { checkMemoryTruncation } from './memory.js';
import { ancestorsRootFirst, joinUnder } from './path-tools.js';
import { listMarkdownFiles, listSubdirectories } from './scan.js';
import type { Candidate, CandidateKind, CandidateOrigin, LoadMode, ScanLimits } from './types.js';

export interface CandidateInput {
  readonly fs: FileSystem;
  readonly paths: ClaudePaths;
  readonly cwd: string;
  readonly addDirs: readonly string[];
  readonly touchedFiles: readonly string[];
  readonly memoryDir: string;
  readonly scan: ScanLimits;
}

interface Spec {
  readonly path: string;
  readonly tier: MemoryTier;
  readonly kind: CandidateKind;
  readonly origin: CandidateOrigin;
  readonly ownerDir: string;
  /** Mode when the file has no `paths` globs. */
  readonly mode: LoadMode;
}

function rulesGlobs(text: string): string[] {
  const { data, error } = parseFrontmatter(text);
  // A rule whose YAML does not parse loads as if it had no paths.
  return error === null ? readStringList(data['paths']) : [];
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
  const globs = spec.kind === 'rule' && text !== null ? rulesGlobs(text) : [];
  return {
    ...spec,
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

type Place = Omit<Spec, 'path' | 'tier' | 'kind'>;

/** CLAUDE.md, .claude/CLAUDE.md, rules and CLAUDE.local.md of one directory, in load order. */
async function dirSpecs(fs: FileSystem, dir: string, place: Place): Promise<Spec[]> {
  const rules = await listMarkdownFiles(fs, path.join(dir, '.claude', 'rules'));
  return [
    { ...place, path: path.join(dir, 'CLAUDE.md'), tier: 'Project', kind: 'claude-md' },
    { ...place, path: path.join(dir, '.claude', 'CLAUDE.md'), tier: 'Project', kind: 'claude-md' },
    ...rules.map((rule): Spec => ({ ...place, path: rule, tier: 'Project', kind: 'rule' })),
    { ...place, path: path.join(dir, 'CLAUDE.local.md'), tier: 'Local', kind: 'local-md' },
  ];
}

function agentsSpecs(dir: string, place: Place): Spec[] {
  return [
    { ...place, path: path.join(dir, 'AGENTS.md'), tier: 'Project', kind: 'agents-md' },
    { ...place, path: path.join(dir, '.claude', 'AGENTS.md'), tier: 'Project', kind: 'agents-md' },
  ];
}

async function userSpecs(input: CandidateInput): Promise<Spec[]> {
  const place: Place = { origin: 'user', ownerDir: input.cwd, mode: 'eager' };
  const rules = await listMarkdownFiles(input.fs, input.paths.userRulesDir);
  return [
    { ...place, path: input.paths.userClaudeMd, tier: 'User', kind: 'claude-md' },
    ...rules.map((rule): Spec => ({ ...place, path: rule, tier: 'User', kind: 'rule' })),
  ];
}

async function treeSpecs(
  input: CandidateInput,
  dirs: readonly string[],
  place: Omit<Place, 'ownerDir'>,
): Promise<Spec[]> {
  const out: Spec[] = [];
  for (const dir of dirs) {
    const own: Place = { ...place, ownerDir: dir };
    out.push(...(await dirSpecs(input.fs, dir, own)));
    if (place.origin !== 'add-dir') {
      out.push(...agentsSpecs(dir, own));
    }
  }
  return out;
}

function memorySpecs(input: CandidateInput, names: readonly string[]): Spec[] {
  const place: Omit<Spec, 'path' | 'kind'> = {
    origin: 'auto-memory',
    ownerDir: input.memoryDir,
    mode: 'auto-memory',
    tier: 'AutoMem',
  };
  const index = path.join(input.memoryDir, 'MEMORY.md');
  const topics = names.filter((name) => name.endsWith('.md') && name !== 'MEMORY.md');
  return [
    { ...place, path: index, kind: 'memory-index' },
    ...topics.map((name): Spec => ({
      ...place,
      path: path.join(input.memoryDir, name),
      kind: 'memory-topic',
    })),
  ];
}

/** Files at fixed places that are worth reporting as missing. */
function alwaysReported(input: CandidateInput): Set<string> {
  return new Set([
    joinUnder(input.paths.managedDir, 'CLAUDE.md'),
    input.paths.userClaudeMd,
    path.join(input.cwd, 'CLAUDE.md'),
    path.join(input.cwd, '.claude', 'CLAUDE.md'),
    path.join(input.cwd, 'CLAUDE.local.md'),
    path.join(input.memoryDir, 'MEMORY.md'),
  ]);
}

/**
 * Every candidate in load order: managed, user, then cwd and its ancestors
 * root first, then lazy subdirectories, then --add-dir dirs, then auto
 * memory. A path appears once (the first place wins), and only files that
 * exist are listed, apart from the fixed locations a user expects to see.
 */
export async function collectCandidates(input: CandidateInput): Promise<Candidate[]> {
  const subdirectories = await listSubdirectories(
    input.fs,
    input.cwd,
    input.touchedFiles,
    input.scan,
  );
  const specs: Spec[] = [
    {
      path: joinUnder(input.paths.managedDir, 'CLAUDE.md'),
      tier: 'Managed',
      kind: 'claude-md',
      origin: 'managed',
      ownerDir: input.cwd,
      mode: 'eager',
    },
    ...(await userSpecs(input)),
    ...(await treeSpecs(input, ancestorsRootFirst(input.cwd), {
      origin: 'ancestor',
      mode: 'eager',
    })),
    ...(await treeSpecs(input, subdirectories, { origin: 'nested', mode: 'lazy-subdir' })),
    ...(await treeSpecs(input, input.addDirs, { origin: 'add-dir', mode: 'eager' })),
    ...memorySpecs(input, await input.fs.readdir(input.memoryDir)),
  ];
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
