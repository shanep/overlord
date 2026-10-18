// How an agent starts: the CLI it runs, terminal tabs, and background jobs.

import type { HandoffKind, SurfaceSession } from '../../shared/protocol.js';
import type { ClaudePaths } from '../paths.js';
import type { Collected } from '../surfaces/common.js';
import type { HandoffCommand } from '../surfaces/handoff.js';
import type { AgentEntry, LiveProcess, RegistryEntry } from '../surfaces/live.js';
import type { AttachClient } from '../surfaces/places.js';
import type { ExecFunction, IsAlive } from '../surfaces/process.js';
import type { Exec } from '../sync/exec.js';

/** The binary to run outside a terminal tab, and the login shell's environment for it. */
export interface AgentCli {
  readonly bin: string;
  readonly env: Readonly<Record<string, string>>;
}

/** What the agent's records of its running sessions are read with. */
export interface LiveSources {
  readonly paths: ClaudePaths;
  /** Throws when the command fails. */
  readonly exec: ExecFunction;
  readonly isAlive: IsAlive;
  /** A current process table when the caller already needed one, null when no terminal is open. */
  readonly processTable?: string | null;
}

/** A tab that starts a session or continues one. */
export interface TerminalStart {
  /** The id a new session or a fork takes, when the agent lets Overlord pick it. */
  readonly sessionId: string;
  /** The first message, which the session starts working on at once. */
  readonly prompt: string | null;
}

/**
 * What a launch profile sets for a tab: its model, effort and permission
 * mode, each null when the profile leaves it to the agent's settings.
 */
export interface TabLaunch {
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: string | null;
}

interface BackgroundStart {
  readonly run: Exec;
  readonly cli: AgentCli;
  /** Flags that go before the agent's own, such as a profile's model. */
  readonly args: readonly string[];
  readonly cwd: string;
  /** The session to continue, or null for a new one. */
  readonly resume: string | null;
  /** Continue a copy of the resumed session under a new id. */
  readonly fork: boolean;
  /** Variables the session needs, such as its worktree's port slot. */
  readonly env: Readonly<Record<string, string>>;
  readonly prompt: string | null;
}

/** The job id a background start printed, or why it did not start. */
export type BackgroundStarted = { readonly jobId: string } | { readonly error: string };

/**
 * Detached sessions that outlive their tab, like `claude --bg`. The list uses
 * Claude Code's words for kind (background, interactive), state (working,
 * blocked, done, stopped, failed) and status (busy, idle), so another agent
 * maps its own onto them.
 */
/** One background job to act on through the agent's CLI. */
interface JobCall {
  readonly run: Exec;
  readonly cli: AgentCli;
  readonly jobId: string;
}

export interface BackgroundFacet {
  start: (input: BackgroundStart) => Promise<BackgroundStarted>;
  /** Args for a tab that shows a running job. */
  attachArgs: (jobId: string) => readonly string[];
  /** The agent's jobs. With all, finished ones too. Never throws. */
  list: (input: {
    readonly exec: ExecFunction;
    readonly bin: string;
    readonly all: boolean;
  }) => Promise<Collected<AgentEntry>>;
  /** Stops a job and keeps its conversation. Resolves to null, or why it did not stop. */
  stop: (input: JobCall) => Promise<string | null>;
  /**
   * Deletes a job that already ended, and the worktree it made if it made
   * one. Resolves to null, or why it did not.
   */
  remove: (input: JobCall) => Promise<string | null>;
  /** The clients showing a job, from `ps -A -o pid=,ppid=,args=`. */
  attachClients: (ps: string) => readonly AttachClient[];
}

/**
 * Terminal tabs, background runs, the agent's own list of running sessions,
 * and the handoffs to its other apps. Workstream B owns it.
 * @public
 */
export interface TerminalFacet {
  /** The binary's name when the user has not set a path. */
  readonly command: string;
  /** True when a new session takes the id newArgs passes, so a tab is tied to it at once. */
  readonly presetId: boolean;
  newArgs: (start: TerminalStart) => readonly string[];
  /** Args to continue sessionId, or with fork a copy of it under start.sessionId. */
  resumeArgs: (sessionId: string, fork: boolean, start: TerminalStart) => readonly string[];
  /**
   * Flags that start a tab on a profile's model, effort and mode, the way
   * the agent's launch overrides give them to a Launcher run. None for a
   * profile that sets none of the three.
   */
  launchArgs?: (launch: TabLaunch) => readonly string[];
  readonly background?: BackgroundFacet;
  /** What interrupts a turn of a session in a plain terminal, or null when only its tab can. */
  readonly interruptSignal: NodeJS.Signals | null;
  /** A tab title for something the agent runs, such as "Claude 8c3efb13". */
  tabName: (label: string) => string;
  /** The live sessions the agent records on this machine, for where each one runs. */
  registry?: (sources: LiveSources) => Promise<Collected<RegistryEntry>>;
  /** The live process holding a session, from every record the agent keeps. */
  findLive: (
    sources: LiveSources & { readonly bin: string },
    sessionId: string,
  ) => Promise<LiveProcess | undefined>;
  /** The command for a handoff to another of the agent's apps, or null when it does not apply. */
  handoff?: (kind: HandoffKind, session: SurfaceSession, bin: string) => HandoffCommand | null;
}
