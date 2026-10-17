// The parts of the resolver that follow an agent's instruction policy rather
// than Claude's own rules: which folders a walk visits, which file wins in a
// folder, and the cap on project files together.

import path from 'node:path';

import type { InstructionBudget, InstructionPolicy, InstructionWhere } from '../agents/types.js';

import type { Verdict } from './gates.js';
import { ancestorsRootFirst, isInside, relativePosix } from './path-tools.js';
import type { Candidate } from './types.js';

export interface Judged {
  readonly candidate: Candidate;
  readonly verdict: Verdict;
}

/** The folders of a walk, root first. `between` takes the policy's between files. */
export interface WalkedFolders {
  /** The folder the walk starts from: the file system root, the git root, or cwd. */
  readonly root: string;
  readonly before: readonly string[];
  readonly between: readonly string[];
  readonly after: readonly string[];
}

/** Every folder from root down to dir, root first. Dir must be inside root. */
function foldersDown(root: string, dir: string): string[] {
  const out: string[] = [];
  for (let current = dir; current !== root; current = path.dirname(current)) {
    out.push(current);
  }
  out.push(root);
  return out.toReversed();
}

export function walkFolders(
  walk: InstructionPolicy['walk'],
  cwd: string,
  gitRoot: string | null,
): WalkedFolders {
  const dir = path.resolve(cwd);
  if (walk === 'root-to-cwd') {
    const before = ancestorsRootFirst(dir);
    return { root: before[0] ?? dir, before, between: [], after: [] };
  }
  // Outside git, or with a git root that does not hold cwd, cwd is the whole project.
  const root = gitRoot !== null && isInside(gitRoot, dir) ? path.resolve(gitRoot) : dir;
  const down = foldersDown(root, dir);
  if (walk === 'git-root-to-cwd') {
    return { root, before: down, between: [], after: [] };
  }
  return {
    root,
    before: [root],
    between: down.slice(1, -1),
    after: root === dir ? [] : [dir],
  };
}

/** The agent's own folder: the variable when it is set, else the folder under home. */
export function agentHome(where: InstructionWhere, variable: string, folder: string): string {
  const value = where.env[variable];
  return value === undefined || value === '' ? path.join(where.home, folder) : path.resolve(value);
}

function inFolderGroup(candidate: Candidate): string | null {
  const { kind, origin } = candidate;
  if (!candidate.exists || kind === 'rule' || kind === 'import' || origin === 'between') {
    return null;
  }
  return origin === 'auto-memory' ? null : `${origin}\n${candidate.ownerDir}`;
}

function firstPerFolder(
  policy: InstructionPolicy,
  candidates: readonly Candidate[],
  out: Map<string, string>,
): void {
  const winners = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const group = inFolderGroup(candidate);
    if (group === null) {
      continue;
    }
    const winner = winners.get(group);
    if (winner === undefined) {
      winners.set(group, candidate);
      continue;
    }
    const name = relativePosix(path.dirname(candidate.path), winner.path);
    out.set(
      candidate.path,
      `${name} is in the same folder and comes first, so ${policy.names.agent} reads only that one.`,
    );
  }
}

function nearestBetween(
  policy: InstructionPolicy,
  candidates: readonly Candidate[],
  root: string,
  out: Map<string, string>,
): void {
  const found = candidates.filter(
    (candidate) => candidate.origin === 'between' && candidate.exists,
  );
  // Every folder between holds cwd, so the longest path is the nearest.
  let winner: Candidate | undefined;
  for (const candidate of found) {
    if (winner === undefined || candidate.ownerDir.length > winner.ownerDir.length) {
      winner = candidate;
    }
  }
  if (winner === undefined) {
    return;
  }
  const name = relativePosix(root, winner.path);
  for (const candidate of found) {
    if (candidate !== winner) {
      out.set(
        candidate.path,
        `Of the folders between the git root and the working directory, ${policy.names.agent} reads only the first file of the nearest one that has any, which is ${name}.`,
      );
    }
  }
}

/** Files that give way to another one, by path, with why. */
export function shadowedFiles(
  policy: InstructionPolicy,
  candidates: readonly Candidate[],
  root: string,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (policy.precedence.kind === 'first-per-folder') {
    firstPerFolder(policy, candidates, out);
  }
  nearestBetween(policy, candidates, root, out);
  return out;
}

function isProjectFile(candidate: Candidate): boolean {
  return (
    (candidate.origin === 'ancestor' || candidate.origin === 'between') &&
    candidate.kind !== 'import'
  );
}

/**
 * Cuts the project files at the budget, in load order. The file that crosses
 * it loads only its head and every one after it is skipped.
 */
export function applyBudget(
  budget: InstructionBudget | null,
  agent: string,
  judged: readonly Judged[],
): Judged[] {
  if (budget === null) {
    return [...judged];
  }
  let used = 0;
  return judged.map((entry): Judged => {
    const { candidate, verdict } = entry;
    if (!verdict.load || !isProjectFile(candidate)) {
      return entry;
    }
    const left = budget.bytes - used;
    if (candidate.bytes <= left) {
      used += candidate.bytes;
      return entry;
    }
    used = budget.bytes;
    if (left > 0) {
      const detail = `${verdict.detail} Only its first ${String(left)} of ${String(candidate.bytes)} bytes load, since ${budget.setting} caps the project files at ${String(budget.bytes)} bytes.`;
      return { candidate: { ...candidate, bytes: left }, verdict: { ...verdict, detail } };
    }
    return {
      candidate,
      verdict: {
        load: false,
        code: 'excluded',
        detail: `The project files before it already fill ${budget.setting} (${String(budget.bytes)} bytes), so ${agent} does not read it.`,
      },
    };
  });
}
