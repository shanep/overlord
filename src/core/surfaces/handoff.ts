// Pure builders for the commands that move a session between surfaces.
// Flags checked against `claude --help` in 2.1.301. Nothing here runs them.

import type { HandoffKind, SurfaceSession } from '../../shared/protocol.js';

export interface HandoffCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly description: string;
}

export interface HandoffOptions {
  /** Defaults to "claude" on PATH. */
  readonly claudeBin?: string;
  /** Remote Control session name. Defaults to the session title. */
  readonly remoteName?: string;
}

const DEFAULT_BIN = 'claude';

/**
 * `claude --bg` args: a new idle session, or one continued under its own id.
 * A background session gets its environment from Claude Code's background
 * service, not from the caller, so variables go in as settings instead.
 */
export function backgroundArgs(
  resume: string | null,
  env: Readonly<Record<string, string>>,
): readonly string[] {
  const settings = Object.keys(env).length === 0 ? [] : ['--settings', JSON.stringify({ env })];
  const session = resume === null ? [] : ['--resume', resume];
  return ['--bg', ...settings, ...session];
}

// `claude --bg` prints "backgrounded · 8c3efb13 (idle ...)" and then hints.
// eslint-disable-next-line no-control-regex -- strips terminal color codes
const ANSI = /\u001B\[[\d;]*m/gu;
const BACKGROUNDED = /backgrounded\s+\S\s+([\da-f]{8})\b/u;

/** The short id `claude --bg` reports for the session it started, or null. */
export function backgroundedId(output: string): string | null {
  return BACKGROUNDED.exec(output.replaceAll(ANSI, ''))?.[1] ?? null;
}

export function resumeLocal(sessionId: string, claudeBin = DEFAULT_BIN): HandoffCommand {
  return {
    command: claudeBin,
    args: ['--resume', sessionId],
    description: `Resume session ${sessionId} in a terminal`,
  };
}

/** Open in Claude Desktop. Without an id Desktop opens on its own picker. */
export function openDesktop(sessionId: string | null, claudeBin = DEFAULT_BIN): HandoffCommand {
  if (sessionId === null) {
    return { command: claudeBin, args: ['--desktop'], description: 'Open Claude Desktop' };
  }
  return {
    command: claudeBin,
    args: ['--desktop', '--resume', sessionId],
    description: `Open session ${sessionId} in Claude Desktop`,
  };
}

export function teleportLocal(sessionId: string, claudeBin = DEFAULT_BIN): HandoffCommand {
  return {
    command: claudeBin,
    args: ['--teleport', sessionId],
    description: `Pull cloud session ${sessionId} into a local terminal`,
  };
}

export interface RemoteControlInput {
  readonly name?: string | null;
  readonly resumeId?: string | null;
}

export function remoteControl(input: RemoteControlInput, claudeBin = DEFAULT_BIN): HandoffCommand {
  const name = input.name?.trim() ?? '';
  const args = name === '' ? ['--remote-control'] : ['--remote-control', name];
  const resumeId = input.resumeId ?? null;
  if (resumeId !== null) {
    args.push('--resume', resumeId);
  }
  return {
    command: claudeBin,
    args,
    description:
      resumeId === null
        ? 'Start a session you can steer from the web or phone'
        : `Resume session ${resumeId} with Remote Control`,
  };
}

const LOCAL_HANDOFFS: readonly HandoffKind[] = ['resume-local', 'open-desktop', 'remote-control'];

/** Which handoffs make sense for a session, by the surface it lives on. */
export function handoffsFor(session: Pick<SurfaceSession, 'surface'>): readonly HandoffKind[] {
  switch (session.surface) {
    case 'cli':
    case 'sdk':
    case 'overlord': {
      return LOCAL_HANDOFFS;
    }
    case 'desktop-code': {
      return ['resume-local', 'open-desktop'];
    }
    case 'cloud': {
      return ['teleport-local'];
    }
    case 'cowork': {
      return ['open-desktop'];
    }
    case 'claude-ai': {
      return [];
    }
  }
}

/**
 * The command for one handoff of one session, or null when that handoff does
 * not apply to the session's surface.
 */
export function buildHandoff(
  kind: HandoffKind,
  session: SurfaceSession,
  options: HandoffOptions = {},
): HandoffCommand | null {
  if (!handoffsFor(session).includes(kind)) {
    return null;
  }
  const bin = options.claudeBin ?? DEFAULT_BIN;
  switch (kind) {
    case 'resume-local': {
      return resumeLocal(session.id, bin);
    }
    case 'open-desktop': {
      // Cowork ids are not CLI session ids, so Desktop opens without one.
      return openDesktop(session.surface === 'cowork' ? null : session.id, bin);
    }
    case 'teleport-local': {
      return teleportLocal(session.id, bin);
    }
    case 'remote-control': {
      return remoteControl(
        { name: options.remoteName ?? session.title, resumeId: session.id },
        bin,
      );
    }
  }
}
