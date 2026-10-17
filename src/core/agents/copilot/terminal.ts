// Copilot CLI in a terminal: `copilot --session-id <id>` for a new session,
// so Overlord picks its id up front, and `copilot --resume=<id>` for an old
// one. A first prompt goes in as --interactive=<prompt>, since -i <prompt>
// fails on a prompt that starts with a dash. Flags checked against `copilot
// --help` in 1.0.89.

import type { HandoffKind } from '../../../shared/protocol.js';
import type { HandoffCommand } from '../../surfaces/handoff.js';
import type { LiveProcess } from '../../surfaces/live.js';
import type { TerminalFacet, TerminalStart } from '../types.js';

import { COPILOT_SHORT } from './capabilities.js';
import { copilotModeFlags } from './config.js';

export const COPILOT_BINARY = 'copilot';
const PS_TIMEOUT_MS = 5000;

/** The flags that name the session a copilot process runs. */
const SESSION_FLAGS = ['--session-id', '--resume', '-r'];

const NO_FORK =
  'Copilot CLI cannot continue a copy of a session from outside it. Use /fork in its tab instead.';

function promptArgs(start: TerminalStart): readonly string[] {
  return start.prompt === null ? [] : [`--interactive=${start.prompt}`];
}

interface PsLine {
  readonly pid: number;
  readonly ppid: number;
  readonly argv: readonly string[];
}

/** Lines of `ps -A -o pid=,ppid=,args=`. A path with a space in it splits too, which only loses a match. */
function parsePs(stdout: string): PsLine[] {
  return stdout.split('\n').flatMap((line) => {
    const [pid, ppid, ...argv] = line.trim().split(/\s+/u);
    const parsed = { pid: Number(pid), ppid: Number(ppid), argv };
    return Number.isInteger(parsed.pid) && Number.isInteger(parsed.ppid) && argv.length > 0
      ? [parsed]
      : [];
  });
}

function isCopilot(word: string): boolean {
  return word.split('/').at(-1) === COPILOT_BINARY;
}

/** True when the argv runs copilot with a flag that names sessionId, as `--flag id` or `--flag=id`. */
function runsSession(argv: readonly string[], sessionId: string): boolean {
  const start = argv.findIndex((word) => isCopilot(word));
  const rest = start === -1 ? [] : argv.slice(start + 1);
  return rest.some(
    (word, index) =>
      (SESSION_FLAGS.includes(word) && rest[index + 1] === sessionId) ||
      SESSION_FLAGS.some((flag) => word === `${flag}=${sessionId}`),
  );
}

/**
 * The outermost copilot process running sessionId, from `ps -A -o
 * pid=,ppid=,args=`. The npm package starts node with the same args, and the
 * outer process is the one the terminal owns. Tabs Overlord opens always name
 * the session, and one started with a bare `copilot` is not found.
 */
export function findCopilot(ps: string, sessionId: string): number | null {
  const matches = parsePs(ps).filter((line) => runsSession(line.argv, sessionId));
  const pids = new Set(matches.map((line) => line.pid));
  return matches.find((line) => !pids.has(line.ppid))?.pid ?? null;
}

function liveProcess(sessionId: string, pid: number): LiveProcess {
  return {
    sessionId,
    pid,
    alive: true,
    state: null,
    status: null,
    kind: 'interactive',
    name: null,
    cwd: null,
    entrypoint: null,
    version: null,
    startedAt: null,
    updatedAt: null,
    agentId: null,
    messagingSocketPath: null,
    sources: [],
  };
}

function resumeArgs(sessionId: string): string[] {
  return [`--resume=${sessionId}`];
}

function handoff(kind: HandoffKind, sessionId: string, bin: string): HandoffCommand | null {
  return kind === 'resume-local'
    ? {
        command: bin,
        args: resumeArgs(sessionId),
        description: `Resume session ${sessionId} in a terminal`,
      }
    : null;
}

export const copilotTerminal: TerminalFacet = {
  command: COPILOT_BINARY,
  presetId: true,
  newArgs: (start) => ['--session-id', start.sessionId, ...promptArgs(start)],
  // Callers check capabilities.fork first, so a fork only gets here by mistake.
  resumeArgs: (sessionId, fork, start) => {
    if (fork) {
      throw new Error(NO_FORK);
    }
    return [...resumeArgs(sessionId), ...promptArgs(start)];
  },
  // --name=value, so a model id that starts with a dash is not read as a flag.
  launchArgs: (launch) =>
    Object.entries(copilotModeFlags(launch)).map(([flag, value]) =>
      value === null ? `--${flag}` : `--${flag}=${value}`,
    ),
  // Copilot shuts down on SIGINT, the same as on SIGTERM, so only Esc in its tab stops a turn.
  interruptSignal: null,
  tabName: (label) => `${COPILOT_SHORT} ${label}`,
  findLive: async (sources, sessionId) => {
    let ps = '';
    try {
      const result = await sources.exec('ps', ['-A', '-o', 'pid=,ppid=,args='], {
        timeoutMs: PS_TIMEOUT_MS,
      });
      ps = result.stdout;
    } catch {
      // No ps, so no process to find.
    }
    const pid = findCopilot(ps, sessionId);
    return pid === null || !sources.isAlive(pid) ? undefined : liveProcess(sessionId, pid);
  },
  handoff: (kind, session, bin) => handoff(kind, session.id, bin),
};
