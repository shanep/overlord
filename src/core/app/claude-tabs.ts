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
/**
 * A new session can take a couple of seconds to show up in `claude agents`,
 * and `claude attach` exits at once ("No job matching ...") until it does,
 * which closes the tab. So wait for it, for up to 15 seconds.
 */
export const READY_TRIES = 30;
export const READY_DELAY_MS = 500;
const SOURCE = 'claude tab';

export interface ClaudeTab {
  readonly name: string;
  readonly cwd: string;
  /** The session to continue, or null for a new one. */
  readonly resume: string | null;
  /** Continue a copy of the resumed session under a new id, leaving the original as it was. */
  readonly fork?: boolean;
  /** Variables the session needs, such as its worktree's port slot. */
  readonly env?: Readonly<Record<string, string>>;
  /** The id a new session takes when claude runs in the tab itself. Random when left out. */
  readonly newId?: string;
  /** The first message, which the session starts working on at once. */
  readonly prompt?: string;
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1).join('');
}

/**
 * Waits until `claude agents` lists the session `claude --bg` started, so a
 * tab can attach to it. Resolves to its full session id, or null when it
 * never shows up.
 */
async function waitUntilListed(
  rt: Runtime,
  short: string,
  claudeBin: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < READY_TRIES; attempt += 1) {
    if (attempt > 0) {
      await rt.delay(READY_DELAY_MS);
    }
    const agents = await readClaudeAgents(rt.surfacesExec, { claudeBin, includeCompleted: true });
    const found = agents.items.find((agent) => agent.id === short);
    if (found !== undefined) {
      return found.sessionId;
    }
  }
  return null;
}

/**
 * Starts the session in the background and attaches a tab to it once Claude
 * Code lists it. Resolves to the session id, null when the session started
 * but never became ready (no tab, and a message saying so), or undefined,
 * with nothing opened, when the session could not start.
 */
async function openAttached(rt: Runtime, tab: ClaudeTab): Promise<string | null | undefined> {
  const cli = await rt.claudeCli();
  const result = await rt.exec(
    cli.bin,
    backgroundArgs(tab.resume, tab.env ?? {}, tab.prompt ?? null, tab.fork === true),
    {
      cwd: tab.cwd,
      timeoutMs: BACKGROUND_TIMEOUT_MS,
      env: cli.env,
    },
  );
  const short = result.code === 0 ? backgroundedId(result.stdout) : null;
  if (short === null) {
    const reason = firstLine(result.stderr) || firstLine(result.stdout);
    rt.report(
      SOURCE,
      `claude --bg did not start a session (exit ${String(result.code)}): ${reason}`,
    );
    return undefined;
  }
  const listed = await waitUntilListed(rt, short, cli.bin);
  if (listed === null) {
    // Attaching now would only flash a tab that closes, so say what happened instead.
    const message = `Claude Code started session ${short} but it did not become ready. Open it from the Fleet in a moment.`;
    rt.report(SOURCE, message);
    rt.host.showWarning(message);
    return null;
  }
  const sessionId = tab.resume?.startsWith(short) === true ? tab.resume : listed;
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

/** Args for a tab that runs claude itself. A fork takes sessionId as its new id. */
function plainArgs(tab: ClaudeTab, sessionId: string): readonly string[] {
  const prompt = tab.prompt === undefined ? [] : [tab.prompt];
  if (tab.resume === null) {
    return ['--session-id', sessionId, ...prompt];
  }
  if (tab.fork === true) {
    return ['--resume', tab.resume, '--fork-session', '--session-id', sessionId, ...prompt];
  }
  return ['--resume', sessionId, ...prompt];
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
  const continued = tab.fork === true ? null : tab.resume;
  const sessionId = continued ?? tab.newId ?? randomUUID();
  rt.host.runInTerminal({
    name: tab.name,
    command: rt.host.settings.claudePath,
    args: plainArgs(tab, sessionId),
    cwd: tab.cwd,
    sessionId,
    ...(tab.env === undefined ? {} : { env: tab.env }),
  });
  return sessionId;
}
