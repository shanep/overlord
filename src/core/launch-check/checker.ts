// Gives every new session a compatibility check of its project, wherever it
// started: in an Overlord worktree, in a checkout Overlord never touched, or
// in a folder outside git. Projects started outside Overlord are the point,
// since they are the ones missing what Overlord's features rely on. Like the
// connector note, the hook reply never waits on a check: SessionStart gets
// the result when a fresh one is ready, and otherwise the session's first
// prompt or tool call after the check finishes does. A worktree Overlord
// hands out starts its repository's check before the session is up.

import path from 'node:path';

import { CLAUDE_CODE, type AgentId } from '../../shared/agents.js';
import type { WorktreeSummary } from '../../shared/protocol.js';
import type { NormalizedHookEvent } from '../hooks/normalized.js';

import type { Finding } from './instructions.js';
import { missing, shownPath } from './instructions.js';
import { compatNote } from './note.js';
import type { LaunchCheck, ProbeTarget } from './probe.js';

/** A result older than this is checked again before a new session hears it. */
export const FRESH_MS = 10 * 60_000;

export interface LaunchCheckerDeps {
  /** False turns the note off. Read on each hook. */
  readonly enabled: () => boolean;
  /** The repository holding a folder, or null when the folder is outside git. */
  readonly locate: (cwd: string) => Promise<ProbeTarget | null>;
  /** Checks the repository for sessions of one agent, which reads its own instruction files. */
  readonly probe: (target: ProbeTarget, agent: AgentId) => Promise<LaunchCheck>;
  /** Overlord's worktrees, including ones made before this window started. */
  readonly worktrees: () => readonly WorktreeSummary[];
  /** Sessions here are chats, not projects, so they get no note. */
  readonly home: string;
  readonly now: () => number;
  readonly formatTime: (at: number) => string;
  readonly report: (message: string) => void;
}

export interface Placed extends ProbeTarget {
  readonly path: string;
}

function inside(folder: string, dir: string): boolean {
  return folder === dir || folder.startsWith(dir + path.sep);
}

/** A folder or repository for one agent, since each agent reads its own files. */
function keyOf(agent: AgentId, folder: string): string {
  return `${agent}\n${folder}`;
}

interface Waiting {
  readonly cwd: string;
  readonly agent: AgentId;
}

export class LaunchChecker {
  /** Results by agent and repository. */
  private readonly results = new Map<string, LaunchCheck>();
  /** The repository of each folder a session started in, or null outside git. */
  private readonly located = new Map<string, ProbeTarget | null>();
  /** Checks running, by agent and the folder they were started for. */
  private readonly jobs = new Map<string, Promise<void>>();
  /** Probes running, by agent and repository, so two folders of one repository share one. */
  private readonly probes = new Map<string, Promise<LaunchCheck>>();
  /** Worktrees handed out since this window started. */
  private readonly placed = new Map<string, Placed>();
  /** Sessions that started before their check was ready, with the folder they started in. */
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly deps: LaunchCheckerDeps) {}

  /** Checks the worktree's repository again, for the agent's session about to start there. */
  prime(worktree: Placed, agent: AgentId = CLAUDE_CODE): void {
    this.placed.set(worktree.path, worktree);
    if (this.deps.enabled()) {
      this.refresh({ cwd: worktree.path, agent }, worktree);
    }
  }

  /** The note to add to this hook's reply, or null. */
  noteFor(event: NormalizedHookEvent): string | null {
    const id = event.sessionId;
    if (event.kind === 'session-end') {
      this.waiting.delete(id);
      return null;
    }
    if (!this.deps.enabled()) {
      return null;
    }
    // Resuming or compacting a session is not a new session, so it is not told again.
    if (event.kind === 'session-start') {
      return event.source === 'new'
        ? this.started(id, { cwd: event.cwd ?? '', agent: event.agent })
        : null;
    }
    // A subagent's context goes away with it, so the note waits for the main thread.
    const later =
      event.kind === 'prompt-submit' ||
      (event.kind === 'post-tool-use' && event.subagentId === null);
    return later ? this.delivered(id) : null;
  }

  private started(id: string, session: Waiting): string | null {
    const { cwd, agent } = session;
    if (cwd === '' || cwd === this.deps.home) {
      return null;
    }
    const place = this.placeOf(cwd);
    const location = place ?? this.located.get(cwd);
    if (location === null) {
      // The folder may have become a repository since, so look again for next time.
      this.refresh(session, null);
      return this.outsideGit(cwd);
    }
    const result =
      location === undefined ? undefined : this.results.get(keyOf(agent, location.repoRoot));
    if (result !== undefined && this.deps.now() - result.checkedAt < FRESH_MS) {
      return this.note(cwd, result);
    }
    this.refresh(session, place);
    this.waiting.set(id, session);
    return null;
  }

  private delivered(id: string): string | null {
    const session = this.waiting.get(id);
    if (session === undefined || this.jobs.has(keyOf(session.agent, session.cwd))) {
      return null;
    }
    this.waiting.delete(id);
    const { cwd, agent } = session;
    const location = this.placeOf(cwd) ?? this.located.get(cwd);
    if (location === null) {
      return this.outsideGit(cwd);
    }
    const result =
      location === undefined ? undefined : this.results.get(keyOf(agent, location.repoRoot));
    return result === undefined ? null : this.note(cwd, result);
  }

  private note(cwd: string, result: LaunchCheck): string {
    const findings = [...this.sessionFindings(cwd, result.repoRoot), ...result.findings];
    return compatNote(
      { folder: result.repoRoot, checkedAt: result.checkedAt, findings },
      this.deps.formatTime,
    );
  }

  private outsideGit(cwd: string): string {
    const text =
      'Git: this folder is not in a git repository, so Overlord cannot give sessions here their own worktree, tell them about each other or land their work. Run `git init` and add an origin remote to use those features.';
    return compatNote(
      { folder: cwd, checkedAt: this.deps.now(), findings: [missing(text)] },
      this.deps.formatTime,
    );
  }

  /** What the session misses by starting outside an Overlord worktree. */
  private sessionFindings(cwd: string, repoRoot: string): readonly Finding[] {
    if (this.placeOf(cwd) !== null) {
      return [];
    }
    const where = shownPath(cwd, this.deps.home, path.dirname(repoRoot));
    const findings = [
      missing(
        `Own worktree: this session was not started by Overlord, so it works in ${where} directly, where other sessions' edits, branch switches and builds can collide with it. It gets no $OVERLORD_SLOT or $OVERLORD_PORT_BASE, and the Worktrees table cannot land or discard its work. Start sessions from Overlord (New Claude Code Session or the launcher) to get one.`,
      ),
    ];
    const managed =
      [...this.placed.values()].some((place) => place.repoRoot === repoRoot) ||
      this.deps.worktrees().some((worktree) => worktree.repoRoot === repoRoot);
    if (!managed) {
      findings.push(
        missing(
          'Session coordination: Overlord has made no worktrees for this repo, so sessions here are not told about each other, edits to a file another session is changing are not paused, and nobody is told to rebase when the default branch moves.',
        ),
      );
    }
    return findings;
  }

  /** Finds the folder's repository if need be, then checks it, in the background. */
  private refresh(session: Waiting, known: ProbeTarget | null): void {
    const { cwd, agent } = session;
    const key = keyOf(agent, cwd);
    if (this.jobs.has(key)) {
      return;
    }
    const job = (async (): Promise<void> => {
      try {
        const location = known ?? (await this.deps.locate(cwd));
        this.located.set(cwd, location);
        if (location !== null) {
          const result = await this.probeOnce(location, agent);
          this.results.set(keyOf(agent, location.repoRoot), result);
        }
      } catch (error: unknown) {
        this.deps.report(`compatibility check failed for ${cwd}: ${String(error)}`);
      } finally {
        this.jobs.delete(key);
      }
    })();
    this.jobs.set(key, job);
  }

  private async probeOnce(target: ProbeTarget, agent: AgentId): Promise<LaunchCheck> {
    const key = keyOf(agent, target.repoRoot);
    const running = this.probes.get(key);
    if (running !== undefined) {
      return running;
    }
    const probe = this.deps.probe(target, agent);
    this.probes.set(key, probe);
    try {
      return await probe;
    } finally {
      this.probes.delete(key);
    }
  }

  /** The Overlord worktree holding cwd, or null for a session outside one. */
  private placeOf(cwd: string): Placed | null {
    for (const place of this.placed.values()) {
      if (inside(cwd, place.path)) {
        return place;
      }
    }
    const known = this.deps.worktrees().find((worktree) => inside(cwd, worktree.path));
    return known === undefined
      ? null
      : { path: known.path, repoRoot: known.repoRoot, target: known.target };
  }

  /** Settles once every running check has, for tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.all(this.jobs.values());
  }
}
