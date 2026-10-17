// Claude Code in a terminal: the argv for new and resumed tabs, background
// jobs through `claude --bg`, `claude attach`, `claude agents`, `claude stop`
// and `claude rm`, the session registry in ~/.claude/sessions, and the handoffs to
// Desktop, the cloud and Remote Control. The builders and parsers stay where
// they were, in surfaces/, and this file points at them.

import { backgroundArgs, backgroundedId, buildHandoff } from '../../surfaces/handoff.js';
import {
  buildLiveProcessTable,
  readClaudeAgents,
  readSessionRegistry,
} from '../../surfaces/live.js';
import { parseAttachClients } from '../../surfaces/places.js';
import type { BackgroundFacet, BackgroundStarted, TerminalFacet, TerminalStart } from '../types.js';

/** What the UI calls Claude Code for short, in "Claude 8c3efb13" and "Continue in Claude". */
export const CLAUDE_SHORT = 'Claude';

/** A cold start of the background service takes several seconds. */
const BACKGROUND_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;

function firstLine(text: string): string {
  return text.trim().split('\n', 1).join('');
}

function promptArgs(start: TerminalStart): readonly string[] {
  return start.prompt === null ? [] : [start.prompt];
}

const background: BackgroundFacet = {
  start: async (input): Promise<BackgroundStarted> => {
    const result = await input.run(
      input.cli.bin,
      backgroundArgs(input.resume, input.env, input.prompt, input.fork),
      { cwd: input.cwd, timeoutMs: BACKGROUND_TIMEOUT_MS, env: input.cli.env },
    );
    const jobId = result.code === 0 ? backgroundedId(result.stdout) : null;
    if (jobId !== null) {
      return { jobId };
    }
    const reason = firstLine(result.stderr) || firstLine(result.stdout);
    return {
      error: `claude --bg did not start a session (exit ${String(result.code)}): ${reason}`,
    };
  },
  attachArgs: (jobId) => ['attach', jobId],
  list: async (input) =>
    readClaudeAgents(input.exec, { claudeBin: input.bin, includeCompleted: input.all }),
  stop: async (input): Promise<string | null> => {
    const result = await input.run(input.cli.bin, ['stop', input.jobId], {
      timeoutMs: STOP_TIMEOUT_MS,
      env: input.cli.env,
    });
    return result.code === 0 ? null : `claude stop ${input.jobId} failed: ${result.stderr.trim()}`;
  },
  // `claude rm` refuses a worktree with unpushed work and says how to discard
  // it, so the whole message goes back to the user.
  remove: async (input): Promise<string | null> => {
    const result = await input.run(input.cli.bin, ['rm', input.jobId], {
      timeoutMs: STOP_TIMEOUT_MS,
      env: input.cli.env,
    });
    const why = result.stderr.trim() || result.stdout.trim();
    return result.code === 0 ? null : `claude rm ${input.jobId} failed: ${why}`;
  },
  attachClients: parseAttachClients,
};

export const claudeTerminal: TerminalFacet = {
  command: 'claude',
  presetId: true,
  newArgs: (start) => ['--session-id', start.sessionId, ...promptArgs(start)],
  resumeArgs: (sessionId, fork, start) =>
    fork
      ? [
          '--resume',
          sessionId,
          '--fork-session',
          '--session-id',
          start.sessionId,
          ...promptArgs(start),
        ]
      : ['--resume', sessionId, ...promptArgs(start)],
  background,
  // A background job takes SIGINT as the end of the job, not of its turn,
  // which is why the caller sends it only to a session in a plain terminal.
  interruptSignal: 'SIGINT',
  tabName: (label) => `${CLAUDE_SHORT} ${label}`,
  registry: async (sources) => readSessionRegistry(sources.paths),
  findLive: async (sources, sessionId) => {
    const table = await buildLiveProcessTable({
      paths: sources.paths,
      exec: sources.exec,
      isAlive: sources.isAlive,
      options: { claudeBin: sources.bin },
    });
    return table.processes.get(sessionId);
  },
  handoff: (kind, session, bin) => buildHandoff(kind, session, { claudeBin: bin }),
};
