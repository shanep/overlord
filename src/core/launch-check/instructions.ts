// The compatibility check's findings from what sessions read: CLAUDE.md files and
// auto memory. It quotes the lines that decide how work lands, and the ones
// that tell a session to make its own worktree.

import path from 'node:path';

import type { FileSystem } from '../context/fs.js';
import { encodeProjectDir } from '../paths.js';

/** missing: an Overlord feature that does not work here. warn: worth raising. info: fine as it is. */
export type FindingLevel = 'missing' | 'warn' | 'info';

export interface Finding {
  readonly level: FindingLevel;
  readonly text: string;
}

export interface InstructionDeps {
  readonly fs: FileSystem;
  readonly home: string;
  readonly userClaudeMd: string;
  readonly projectsDir: string;
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

/** The repository's instruction files that exist: its own and one folder down. */
export async function repoInstructions(fs: FileSystem, repoRoot: string): Promise<Instructions> {
  const top = await fs.readdir(repoRoot);
  const candidates = [
    'CLAUDE.md',
    'CLAUDE.local.md',
    path.join('.claude', 'CLAUDE.md'),
    ...top.filter((name) => !name.startsWith('.')).map((name) => path.join(name, 'CLAUDE.md')),
  ];
  const files = await Promise.all(
    candidates.map(async (name) => {
      const text = await fs.readFile(path.join(repoRoot, name));
      return text === null ? null : ([name, text] as const);
    }),
  );
  return files.filter((file) => file !== null);
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
  const userText = (await deps.fs.readFile(deps.userClaudeMd)) ?? '';
  const user: Instructions = [[shownPath(deps.userClaudeMd, deps.home, repoRoot), userText]];
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

/** How much auto memory the session shares, and advice in it or the repo to make a worktree. */
export async function memoryFindings(
  deps: InstructionDeps,
  repoRoot: string,
  instructions: Instructions,
): Promise<readonly Finding[]> {
  const dir = path.join(deps.projectsDir, encodeProjectDir(repoRoot), 'memory');
  const shownDir = shownPath(dir, deps.home, repoRoot);
  const index = await deps.fs.readFile(path.join(dir, 'MEMORY.md'));
  const entries = index?.split('\n').filter((line) => line.startsWith('- ')).length ?? 0;
  const findings: Finding[] = [
    entries === 0
      ? info('No auto memory for this repo yet.')
      : info(
          `Auto memory: ${String(entries)} entries in ${shownDir}, shared with the main checkout.`,
        ),
  ];
  const listing = await deps.fs.readdir(dir);
  const memories = await Promise.all(
    listing
      .filter((name) => name.endsWith('.md'))
      .map(async (name) => {
        const text = await deps.fs.readFile(path.join(dir, name));
        return [`${shownDir}/${name}`, text ?? ''] as const;
      }),
  );
  const [told] = each([...instructions, ...memories], MAKES_WORKTREE, true);
  if (told !== undefined) {
    findings.push(
      warn(
        `${quoteOf(told)} tells sessions to make their own worktree. A session Overlord starts already has one, so it should work there and not make another.`,
      ),
    );
  }
  return findings;
}
