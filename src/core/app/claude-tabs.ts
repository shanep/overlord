// Claude tabs Overlord opens run `claude attach` on a background session, so
// closing a tab only closes the view. The session keeps running in the
// background, where the fleet still shows it, instead of VS Code asking
// whether to terminate it. When Claude Code cannot start a background session
// the tab runs claude itself, as it did before. Each step goes through the
// tab's agent's terminal facet, and an agent with no background runs always
// gets a plain tab.

import { randomUUID } from 'node:crypto';

import type { AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { AgentTerminal } from '../agents/terminals.js';
import { terminalOf } from '../agents/terminals.js';
import type { BackgroundFacet } from '../agents/types.js';

import { agentCli, newSessionIn, terminalCommand } from './agent-terminal.js';
import type { Runtime } from './runtime.js';

/**
 * A new session can take a couple of seconds to show up in `claude agents`,
 * and `claude attach` exits at once ("No job matching ...") until it does,
 * which closes the tab. So wait for it, for up to 15 seconds.
 */
export const READY_TRIES = 30;
export const READY_DELAY_MS = 500;
const SOURCE = 'claude tab';

export interface ClaudeTab {
  /** The agent the tab runs. Claude Code when left out. */
  readonly agent?: AgentId;
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
  /** CLI args that go before the session's own, such as the bridge's model. */
  readonly args?: readonly string[];
  /** Runs the agent in the tab itself, for a session that cannot outlive the window. */
  readonly foreground?: boolean;
}

/**
 * Waits until the agent lists the job a background start reported, so a tab
 * can attach to it. Resolves to its full session id, or null when it never
 * shows up.
 */
async function waitUntilListed(
  rt: Runtime,
  background: BackgroundFacet,
  short: string,
  bin: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < READY_TRIES; attempt += 1) {
    if (attempt > 0) {
      await rt.delay(READY_DELAY_MS);
    }
    const agents = await background.list({ exec: rt.surfacesExec, bin, all: true });
    const found = agents.items.find((agent) => agent.id === short);
    if (found !== undefined) {
      return found.sessionId;
    }
  }
  return null;
}

/**
 * Starts the session in the background and attaches a tab to it once the
 * agent lists it. Resolves to the session id, null when the session started
 * but never became ready (no tab, and a message saying so), or undefined,
 * with nothing opened, when the session could not start.
 */
async function openAttached(
  rt: Runtime,
  at: AgentTerminal,
  background: BackgroundFacet,
  tab: ClaudeTab,
): Promise<string | null | undefined> {
  const cli = await agentCli(rt, at);
  const started = await background.start({
    run: rt.exec,
    cli,
    cwd: tab.cwd,
    resume: tab.resume,
    fork: tab.fork === true,
    env: tab.env ?? {},
    prompt: tab.prompt ?? null,
  });
  if ('error' in started) {
    rt.report(SOURCE, started.error);
    return undefined;
  }
  const short = started.jobId;
  const listed = await waitUntilListed(rt, background, short, cli.bin);
  if (listed === null) {
    // Attaching now would only flash a tab that closes, so say what happened instead.
    const message = `${at.adapter.name} started session ${short} but it did not become ready. Open it from the Fleet in a moment.`;
    rt.report(SOURCE, message);
    rt.host.showWarning(message);
    return null;
  }
  const sessionId = tab.resume?.startsWith(short) === true ? tab.resume : listed;
  rt.host.runInTerminal({
    name: tab.name,
    command: terminalCommand(rt, at),
    args: background.attachArgs(short),
    cwd: tab.cwd,
    sessionId,
  });
  void rt.places.refresh();
  void rt.jobs.refresh();
  return sessionId;
}

/** Args for a tab that runs the agent itself. A fork takes sessionId as its new id. */
function plainArgs(at: AgentTerminal, tab: ClaudeTab, sessionId: string): readonly string[] {
  const start = { sessionId, prompt: tab.prompt ?? null };
  const before = tab.args ?? [];
  if (tab.resume === null) {
    return [...before, ...at.terminal.newArgs(start)];
  }
  return [...before, ...at.terminal.resumeArgs(tab.resume, tab.fork === true, start)];
}

/** A tab that runs the agent itself. Resolves to the session id it runs, when known. */
function openPlain(rt: Runtime, at: AgentTerminal, tab: ClaudeTab): string | null {
  const continued = tab.fork === true ? null : tab.resume;
  const sessionId = continued ?? tab.newId ?? randomUUID();
  // An agent that picks a new session's id itself leaves the tab untied until it says.
  const known = continued !== null || at.terminal.presetId;
  rt.host.runInTerminal({
    name: tab.name,
    command: terminalCommand(rt, at),
    args: plainArgs(at, tab, sessionId),
    cwd: tab.cwd,
    sessionId: known ? sessionId : null,
    ...(known ? {} : { sessionLater: newSessionIn(rt, at.adapter.id, tab.cwd) }),
    ...(tab.env === undefined ? {} : { env: tab.env }),
  });
  return known ? sessionId : null;
}

/**
 * Opens a tab whose session outlives it, or a plain one when the background
 * start fails or the agent has none. Resolves to the session id the tab
 * runs, when known.
 */
export async function openClaudeTab(rt: Runtime, tab: ClaudeTab): Promise<string | null> {
  const at = terminalOf(tab.agent ?? CLAUDE_CODE);
  if (at === null) {
    rt.report(SOURCE, `${tab.agent ?? CLAUDE_CODE} cannot open in a terminal`);
    return null;
  }
  const { background } = at.terminal;
  const attached =
    background === undefined || tab.foreground === true
      ? undefined
      : await openAttached(rt, at, background, tab);
  if (attached !== undefined) {
    return attached;
  }
  // A new session or a fork hears Overlord's notes at launch when its agent takes them that way.
  const fresh = tab.resume === null || tab.fork === true;
  const pending = fresh ? rt.launchNotes.args(at.adapter.id, tab.cwd) : null;
  const notes = pending === null ? [] : await pending;
  return openPlain(
    rt,
    at,
    notes.length === 0 ? tab : { ...tab, args: [...notes, ...(tab.args ?? [])] },
  );
}
