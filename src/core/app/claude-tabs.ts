// Claude tabs Overlord opens run `claude attach` on a background session, so
// closing a tab only closes the view. The session keeps running in the
// background, where the fleet still shows it, instead of VS Code asking
// whether to terminate it. When Claude Code cannot start a background session
// the tab runs claude itself, as it did before.

import { randomUUID } from 'node:crypto';

import { backgroundArgs, backgroundedId } from '../surfaces/handoff.js';
import { readClaudeAgents } from '../surfaces/live.js';

import type { Runtime } from './runtime.js';

/** A cold start of the background service takes several seconds. */
const BACKGROUND_TIMEOUT_MS = 30_000;
/** A new session can take a moment to show up in `claude agents`. */
const LOOKUP_TRIES = 3;
const LOOKUP_DELAY_MS = 500;
const SOURCE = 'claude tab';

export interface ClaudeTab {
  readonly name: string;
  readonly cwd: string;
  /** The session to continue, or null for a new one. */
  readonly resume: string | null;
  /** Variables the session needs, such as its worktree's port slot. */
  readonly env?: Readonly<Record<string, string>>;
  /** The id a new session takes when claude runs in the tab itself. Random when left out. */
  readonly newId?: string;
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1).join('');
}

/** The full session id behind the short one `claude --bg` printed, or null when unknown. */
async function sessionIdFor(
  rt: Runtime,
  short: string,
  resume: string | null,
): Promise<string | null> {
  if (resume?.startsWith(short) === true) {
    return resume;
  }
  for (let attempt = 0; attempt < LOOKUP_TRIES; attempt += 1) {
    if (attempt > 0) {
      await rt.delay(LOOKUP_DELAY_MS);
    }
    const agents = await readClaudeAgents(rt.surfacesExec, {
      claudeBin: rt.host.settings.claudePath,
      includeCompleted: true,
    });
    const found = agents.items.find((agent) => agent.id === short);
    if (found !== undefined) {
      return found.sessionId;
    }
  }
  return null;
}

/**
 * Starts the session in the background and attaches a tab to it. Resolves to
 * the session id (null when Claude Code does not list it yet), or undefined,
 * with nothing opened, when the session could not start.
 */
async function openAttached(rt: Runtime, tab: ClaudeTab): Promise<string | null | undefined> {
  const cli = await rt.claudeCli();
  const result = await rt.exec(cli.bin, backgroundArgs(tab.resume, tab.env ?? {}), {
    cwd: tab.cwd,
    timeoutMs: BACKGROUND_TIMEOUT_MS,
    env: cli.env,
  });
  const short = result.code === 0 ? backgroundedId(result.stdout) : null;
  if (short === null) {
    const reason = firstLine(result.stderr) || firstLine(result.stdout);
    rt.report(
      SOURCE,
      `claude --bg did not start a session (exit ${String(result.code)}): ${reason}`,
    );
    return undefined;
  }
  const sessionId = await sessionIdFor(rt, short, tab.resume);
  rt.host.runInTerminal({
    name: tab.name,
    command: rt.host.settings.claudePath,
    args: ['attach', short],
    cwd: tab.cwd,
    sessionId,
  });
  void rt.places.refresh();
  void rt.jobs.refresh();
  return sessionId;
}

/**
 * Opens a Claude tab whose session outlives it, or a plain one when the
 * background start fails. Resolves to the session id the tab runs, when known.
 */
export async function openClaudeTab(rt: Runtime, tab: ClaudeTab): Promise<string | null> {
  const attached = await openAttached(rt, tab);
  if (attached !== undefined) {
    return attached;
  }
  const sessionId = tab.resume ?? tab.newId ?? randomUUID();
  rt.host.runInTerminal({
    name: tab.name,
    command: rt.host.settings.claudePath,
    args: tab.resume === null ? ['--session-id', sessionId] : ['--resume', sessionId],
    cwd: tab.cwd,
    sessionId,
    ...(tab.env === undefined ? {} : { env: tab.env }),
  });
  return sessionId;
}
