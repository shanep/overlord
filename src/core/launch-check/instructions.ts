// The compatibility check's findings from what sessions read: the instruction
// files the session's agent loads (CLAUDE.md and AGENTS.md for Claude Code)
// and Claude's auto memory. It quotes the lines that decide how work lands,
// and the ones that tell a session to make its own worktree.

import path from 'node:path';

import type { InstructionEntry, InstructionFile, InstructionPolicy } from '../agents/types.js';
import { underDir } from '../context/candidates.js';
import type { FileSystem } from '../context/fs.js';
import { encodeProjectDir } from '../paths.js';

/** missing: an Overlord feature that does not work here. warn: worth raising. info: fine as it is. */
type FindingLevel = 'missing' | 'warn' | 'info';

export interface Finding {
  readonly level: FindingLevel;
  readonly text: string;
}

/** What the session's agent reads, from its instruction policy. */
export interface AgentReads {
  readonly policy: InstructionPolicy;
  /** The agent's own folder, which holds its user files. */
  readonly configDir: string;
  /** Claude's projects folder, which holds auto memory. */
  readonly projectsDir: string;
}

export interface InstructionDeps {
  readonly fs: FileSystem;
  readonly home: string;
  /** Null for an agent without an instruction policy, whose files are not read. */
  readonly reads: AgentReads | null;
}

/** An instruction file's path as shown to the session, and its text. */
export type Instructions = readonly (readonly [string, string])[];

/** One line of an instruction file, for quoting it back. */
interface Quote {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const MAX_LISTED = 5;
const MAX_QUOTE = 120;
const NEGATED = /\b(?:no|not|never|don't|do not)\b/iu;
const LANDS_DIRECT = [
  /\bno pull requests\b/iu,
  /\bpush(?:es)?\b[^.\n]{1,20}?\bto (?:the )?(?:default branch|main|master)\b/iu,
  /\bgit push origin HEAD:/u,
];
const OPENS_PR = [
  /\b(?:opens?|creates?|raise)\b[^.\n]{1,40}?\b(?:pull requests?|PRs?)\b/iu,
  /\bgh pr create\b/u,
];
const MAKES_WORKTREE = [/\bEnterWorktree\b/u, /\bgit worktree add\b/u];

export function missing(text: string): Finding {
  return { level: 'missing', text };
}

export function warn(text: string): Finding {
  return { level: 'warn', text };
}

export function info(text: string): Finding {
  return { level: 'info', text };
}

export function listed(items: readonly string[]): string {
  const head = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${head} and ${String(items.length - MAX_LISTED)} more` : head;
}

/** The path as a person reads it: relative to the repository, or with ~ for home. */
export function shownPath(file: string, home: string, repoRoot: string): string {
  if (file.startsWith(repoRoot + path.sep)) {
    return path.relative(repoRoot, file);
  }
  return file.startsWith(home + path.sep) ? `~/${path.relative(home, file)}` : file;
}

function quoteOf(quote: Quote): string {
  const text = quote.text.trim().replaceAll(/\s+/gu, ' ');
  const short = text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE - 3)}...` : text;
  return `${quote.file}:${String(quote.line)} ("${short}")`;
}

function matching(
  file: string,
  text: string,
  patterns: readonly RegExp[],
  skipNegated: boolean,
): Quote[] {
  return text.split('\n').flatMap((line, index) => {
    const match = patterns.map((pattern) => pattern.exec(line)).find((found) => found !== null);
    if (match === undefined) {
      return [];
    }
    // "Do not open a PR" says the opposite of what the pattern looks for.
    if (skipNegated && NEGATED.test(line.slice(0, match.index))) {
      return [];
    }
    return [{ file, line: index + 1, text: line }];
  });
}

function each(instructions: Instructions, patterns: readonly RegExp[], skip: boolean): Quote[] {
  return instructions.flatMap(([file, text]) => matching(file, text, patterns, skip));
}

interface Found {
  readonly entry: InstructionFile;
  readonly path: string;
  readonly text: string;
}

/** The files of one folder the agent reads, after the one that wins hides the rest. */
async function folderFiles(
  fs: FileSystem,
  dir: string,
  entries: readonly InstructionEntry[],
  policy: InstructionPolicy,
): Promise<Found[]> {
  const files = entries.filter((entry): entry is InstructionFile => 'file' in entry);
  const read = await Promise.all(
    files.map(async (entry) => {
      const file = underDir(dir, entry.file);
      const text = await fs.readFile(file);
      return text === null ? null : { entry, path: file, text };
    }),
  );
  const found = read.filter((file) => file !== null);
  const { precedence } = policy;
  if (precedence.kind === 'first-per-folder') {
    return found.slice(0, 1);
  }
  if (precedence.kind === 'shadowed') {
    const hides = found.some((file) => precedence.by.includes(file.entry.kind));
    return hides ? found.filter((file) => !precedence.shadowed.includes(file.entry.kind)) : found;
  }
  return found;
}

/**
 * The repository's instruction files the agent reads: the root's, and one
 * folder down for an agent that loads subfolders once it works in them.
 */
export async function repoInstructions(
  fs: FileSystem,
  repoRoot: string,
  policy: InstructionPolicy | null,
): Promise<Instructions> {
  if (policy === null) {
    return [];
  }
  const top = policy.lazySubfolders ? await fs.readdir(repoRoot) : [];
  const below = top.filter((name) => !name.startsWith('.'));
  const folders = [repoRoot, ...below.map((name) => path.join(repoRoot, name))];
  const found = await Promise.all(
    folders.map(async (dir) => folderFiles(fs, dir, policy.project, policy)),
  );
  return found.flat().map((file) => [path.relative(repoRoot, file.path), file.text] as const);
}

/** The instruction files in the agent's own folder, shown as a person reads them. */
async function userInstructions(deps: InstructionDeps, repoRoot: string): Promise<Instructions> {
  if (deps.reads === null) {
    return [];
  }
  const { policy, configDir } = deps.reads;
  const found = await folderFiles(deps.fs, configDir, policy.user, policy);
  return found.map((file) => [shownPath(file.path, deps.home, repoRoot), file.text] as const);
}

export interface Landing {
  readonly findings: readonly Finding[];
  /** True when some instruction says to push straight to the default branch. */
  readonly direct: boolean;
}

function firstPair(
  first: readonly Quote[],
  second: readonly Quote[],
): readonly [Quote, Quote] | null {
  const [a] = first;
  const [b] = second;
  return a === undefined || b === undefined ? null : [a, b];
}

/** Whether the user's and the repository's instructions agree on how work lands. */
export async function landingFindings(
  deps: InstructionDeps,
  repoRoot: string,
  instructions: Instructions,
): Promise<Landing> {
  const user = await userInstructions(deps, repoRoot);
  const userDirect = each(user, LANDS_DIRECT, false);
  const userPr = each(user, OPENS_PR, true);
  const repoDirect = each(instructions, LANDS_DIRECT, false);
  const repoPr = each(instructions, OPENS_PR, true);
  const direct = userDirect.length > 0 || repoDirect.length > 0;
  const conflict = firstPair(userDirect, repoPr) ?? firstPair(userPr, repoDirect);
  if (conflict !== null) {
    const [mine, theirs] = conflict;
    return {
      direct,
      findings: [
        warn(
          `The instructions disagree on how work lands: ${quoteOf(mine)}, but ${quoteOf(theirs)}. Ask the user which applies before landing anything.`,
        ),
      ],
    };
  }
  // The repository's own rule is the one that applies when nothing disagrees.
  const [rule] = [...repoPr, ...repoDirect, ...userPr, ...userDirect];
  return {
    direct,
    findings: rule === undefined ? [] : [info(`Work lands as ${quoteOf(rule)} says.`)],
  };
}

interface Memory {
  readonly finding: Finding;
  readonly files: Instructions;
}

/** How much auto memory the repository has, and its files. */
async function autoMemory(
  deps: InstructionDeps,
  projectsDir: string,
  repoRoot: string,
): Promise<Memory> {
  const dir = path.join(projectsDir, encodeProjectDir(repoRoot), 'memory');
  const shownDir = shownPath(dir, deps.home, repoRoot);
  const index = await deps.fs.readFile(path.join(dir, 'MEMORY.md'));
  const entries = index?.split('\n').filter((line) => line.startsWith('- ')).length ?? 0;
  const finding =
    entries === 0
      ? info('No auto memory for this repo yet.')
      : info(
          `Auto memory: ${String(entries)} entries in ${shownDir}, shared with the main checkout.`,
        );
  const listing = await deps.fs.readdir(dir);
  const files = await Promise.all(
    listing
      .filter((name) => name.endsWith('.md'))
      .map(async (name) => {
        const text = await deps.fs.readFile(path.join(dir, name));
        return [`${shownDir}/${name}`, text ?? ''] as const;
      }),
  );
  return { finding, files };
}

/**
 * How much auto memory the session shares, for an agent that keeps it, and
 * advice in it or the repo to make a worktree.
 */
export async function memoryFindings(
  deps: InstructionDeps,
  repoRoot: string,
  instructions: Instructions,
): Promise<readonly Finding[]> {
  const memory =
    deps.reads?.policy.autoMemory === true
      ? await autoMemory(deps, deps.reads.projectsDir, repoRoot)
      : null;
  const findings: Finding[] = memory === null ? [] : [memory.finding];
  const [told] = each([...instructions, ...(memory?.files ?? [])], MAKES_WORKTREE, true);
  if (told !== undefined) {
    findings.push(
      warn(
        `${quoteOf(told)} tells sessions to make their own worktree. A session Overlord starts already has one, so it should work there and not make another.`,
      ),
    );
  }
  return findings;
}
