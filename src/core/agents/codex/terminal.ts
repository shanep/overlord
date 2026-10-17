// Codex CLI in a terminal: `codex [PROMPT]` for a new session, `codex resume
// <id>` and `codex fork <id>` for an old one. Flags checked against `codex
// --help` in 0.163.0. Codex picks a new thread's id itself, so a new tab is
// tied to its session once the rollout shows up (claude-tabs.ts).

import type { HandoffKind } from '../../../shared/protocol.js';
import type { HandoffCommand } from '../../surfaces/handoff.js';
import type { LiveProcess } from '../../surfaces/live.js';
import type { TerminalFacet, TerminalStart } from '../types.js';

import { CODEX_SHORT } from './capabilities.js';

const PS_TIMEOUT_MS = 5000;

function promptArgs(start: TerminalStart): readonly string[] {
  return start.prompt === null ? [] : [start.prompt];
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

function isCodex(word: string): boolean {
  const name = word.split('/').at(-1);
  return name === 'codex' || name === 'codex.js';
}

/** True when the argv runs codex with `resume <sessionId>`. */
function resumes(argv: readonly string[], sessionId: string): boolean {
  const start = argv.findIndex((word) => isCodex(word));
  const rest = start === -1 ? [] : argv.slice(start + 1);
  const at = rest.indexOf('resume');
  return at !== -1 && rest[at + 1] === sessionId;
}

/**
 * The outermost codex process running `codex resume <sessionId>`, from `ps -A
 * -o pid=,ppid=,args=`. The npm package starts a node wrapper that runs the
 * native binary with the same args, and the wrapper is the one the terminal
 * owns. A new session's process names no id, so it is not found.
 */
export function findResumed(ps: string, sessionId: string): number | null {
  const matches = parsePs(ps).filter((line) => resumes(line.argv, sessionId));
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

function handoff(kind: HandoffKind, sessionId: string, bin: string): HandoffCommand | null {
  return kind === 'resume-local'
    ? {
        command: bin,
        args: ['resume', sessionId],
        description: `Resume session ${sessionId} in a terminal`,
      }
    : null;
}

export const codexTerminal: TerminalFacet = {
  command: 'codex',
  presetId: false,
  newArgs: (start) => promptArgs(start),
  // A fork gets its own new id from Codex, so start.sessionId goes unused.
  resumeArgs: (sessionId, fork, start) => [
    fork ? 'fork' : 'resume',
    sessionId,
    ...promptArgs(start),
  ],
  // The Codex TUI quits on SIGINT instead of stopping the turn, so only Esc in its tab interrupts.
  interruptSignal: null,
  tabName: (label) => `${CODEX_SHORT} ${label}`,
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
    const pid = findResumed(ps, sessionId);
    return pid === null || !sources.isAlive(pid) ? undefined : liveProcess(sessionId, pid);
  },
  handoff: (kind, session, bin) => handoff(kind, session.id, bin),
};
