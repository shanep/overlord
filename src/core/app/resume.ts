// Continuing a session in its own folder. A session keeps what it got when it
// started, so one from before Overlord gave every session a worktree, one
// whose worktree was tidied away, or one whose branch fell behind is missing
// things a new session has. Continue says which, and offers to bring the
// session up to date first. Overlord's hook notes need nothing, since Claude
// Code sends SessionStart again on a resume.

import path from 'node:path';

import type { SurfaceSession } from '../../shared/protocol.js';

import { openClaudeTab } from './claude-tabs.js';
import { messageOf } from './errors.js';
import type { Runtime } from './runtime.js';
import { heldWorktreeEnv, startSession, worktreeRoot } from './worktrees.js';

export const UPDATE = 'Bring up to date';
export const AS_IS = 'Continue as is';

// Claude Code's own worktrees sit at <repo>/.claude/worktrees/<name>, and keep a session apart too.
const CLAUDE_WORKTREE = `${path.sep}.claude${path.sep}worktrees${path.sep}`;

type Gap =
  | { readonly kind: 'shared' }
  | { readonly kind: 'restored'; readonly target: string }
  | {
      readonly kind: 'behind';
      readonly id: string;
      readonly count: number;
      readonly target: string;
    };

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

function gapText(gap: Gap, cwd: string): string {
  switch (gap.kind) {
    case 'shared': {
      return `It works in ${cwd} itself, not its own worktree, so other sessions can change its files and it has no port slot.`;
    }
    case 'restored': {
      return `Its worktree was removed once its work landed, so Overlord made it again from the latest ${gap.target}, and files it remembers may have changed.`;
    }
    case 'behind': {
      return `Its branch is ${plural(gap.count, 'commit')} behind origin/${gap.target}.`;
    }
  }
}

function isIsolated(rt: Runtime, cwd: string): boolean {
  const root = worktreeRoot(rt.paths);
  return cwd === root || cwd.startsWith(`${root}${path.sep}`) || cwd.includes(CLAUDE_WORKTREE);
}

/** Holds the worktree the session works in for this window, so the session gets its variables. */
async function holdWorktree(rt: Runtime, sessionId: string, id: string): Promise<void> {
  try {
    if ((await rt.worktrees.adopt(id)) !== null) {
      rt.sessionWorktrees.set(sessionId, id);
    }
  } catch (error: unknown) {
    rt.report('worktrees', messageOf(error));
  }
}

/** Lets go of the worktree held for a session that did not continue after all. */
async function letGo(rt: Runtime, sessionId: string): Promise<void> {
  const id = rt.sessionWorktrees.get(sessionId);
  if (id === undefined) {
    return;
  }
  rt.sessionWorktrees.delete(sessionId);
  try {
    await rt.worktrees.release(id);
  } catch (error: unknown) {
    rt.report('worktrees', messageOf(error));
  }
}

async function findGaps(rt: Runtime, cwd: string, restored: boolean): Promise<Gap[]> {
  const entry = await rt.worktrees.entryFor(cwd);
  if (entry === null) {
    const repoRoot = await rt.worktrees.repoRoot(cwd);
    return repoRoot !== null && !isIsolated(rt, cwd) ? [{ kind: 'shared' }] : [];
  }
  if (entry.target === null) {
    return [];
  }
  if (restored) {
    // A fresh worktree starts from the latest default branch, so it cannot be behind.
    return [{ kind: 'restored', target: entry.target }];
  }
  const count = await rt.worktrees.behind(entry.id).catch(() => 0);
  return count > 0 ? [{ kind: 'behind', id: entry.id, count, target: entry.target }] : [];
}

/** The first message of a session brought up to date, so it looks again before going on. */
export function refreshPrompt(done: readonly string[]): string {
  return [
    'Overlord brought this session up to date before you continue:',
    ...done.map((line) => `- ${line}`),
    'Files may have changed since you last looked, and so may the CLAUDE.md files and your memory.',
    'Check the current state of the code (git status and git log are a good start), then tell me',
    'in a few lines where things stand and wait for what I want next.',
  ].join('\n');
}

/** Rebases a branch that fell behind. What happened goes in the prompt either way. */
async function catchUp(rt: Runtime, gap: Gap & { readonly kind: 'behind' }): Promise<string> {
  try {
    await rt.worktrees.update(gap.id);
    return `Rebased this worktree's branch onto the latest origin/${gap.target}, which had ${plural(gap.count, 'new commit')}.`;
  } catch (error: unknown) {
    const reason = messageOf(error);
    rt.host.showWarning(`Overlord could not update the branch: ${reason}`);
    return `Tried to rebase this worktree's branch onto origin/${gap.target} and could not: ${reason}`;
  }
}

export interface Continuing {
  readonly session: SurfaceSession;
  readonly cwd: string;
  /** The tab's name. */
  readonly name: string;
  /** Overlord just made the session's worktree again. */
  readonly restored: boolean;
}

/** What Continue does once the user has seen what the session is missing. */
type Plan = { readonly kind: 'stop' } | { readonly kind: 'resume'; readonly prompt?: string };

/**
 * Asks about the gaps and brings the session up to date when the user wants
 * that. A session in the shared checkout continues as a copy in a new
 * worktree right here, since a session cannot move.
 */
async function settleGaps(rt: Runtime, at: Continuing, gaps: readonly Gap[]): Promise<Plan> {
  const { session, cwd, name } = at;
  const title = session.title === '' ? 'This session' : `"${session.title}"`;
  const message = [
    `${title} may be missing Overlord features.`,
    ...gaps.map((gap) => gapText(gap, cwd)),
  ];
  const choice = await rt.host.ask(message.join(' '), [UPDATE, AS_IS]);
  if (choice === null) {
    await letGo(rt, session.id);
    return { kind: 'stop' };
  }
  if (choice !== UPDATE) {
    return { kind: 'resume' };
  }
  if (gaps.some((gap) => gap.kind === 'shared')) {
    const moved = `Moved this session into its own worktree, from the latest default branch. The original stays in ${cwd}, with any edits it left there.`;
    await startSession(rt, cwd, { name, forkOf: session.id, prompt: refreshPrompt([moved]) });
    return { kind: 'stop' };
  }
  const done: string[] = [];
  for (const gap of gaps) {
    done.push(gap.kind === 'behind' ? await catchUp(rt, gap) : gapText(gap, cwd));
  }
  return { kind: 'resume', prompt: refreshPrompt(done) };
}

/** Continues a session in its folder, after saying what it is missing when it is missing something. */
export async function continueHere(rt: Runtime, at: Continuing): Promise<void> {
  const { session, cwd, name, restored } = at;
  const entry = await rt.worktrees.entryFor(cwd);
  if (entry !== null && !restored) {
    await holdWorktree(rt, session.id, entry.id);
  }
  const gaps = await findGaps(rt, cwd, restored);
  const plan: Plan = gaps.length === 0 ? { kind: 'resume' } : await settleGaps(rt, at, gaps);
  if (plan.kind === 'stop') {
    return;
  }
  const env = await heldWorktreeEnv(rt, session.id);
  await openClaudeTab(rt, {
    name,
    cwd,
    resume: session.id,
    ...(env === undefined ? {} : { env }),
    ...(plan.prompt === undefined ? {} : { prompt: plan.prompt }),
  });
}
