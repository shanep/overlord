// Runs the launch check for a repository whenever Overlord hands out one of
// its worktrees, and gives each new session there the result. Like the
// connector note, the hook reply never waits on a check: SessionStart gets
// the result when a fresh one is ready, and otherwise the session's first
// prompt or tool call after the check finishes does.

import path from 'node:path';

import type { WorktreeSummary } from '../../shared/protocol.js';
import type { KnownPayload } from '../hooks/payloads.js';

import { launchNote } from './note.js';
import type { LaunchCheck, ProbeTarget } from './probe.js';

/** A result older than this is checked again before a new session hears it. */
export const FRESH_MS = 10 * 60_000;

export interface LaunchCheckerDeps {
  /** False turns the note off. Read on each hook. */
  readonly enabled: () => boolean;
  readonly probe: (target: ProbeTarget) => Promise<LaunchCheck>;
  /** Overlord's worktrees, for sessions in one made before this window started. */
  readonly worktrees: () => readonly WorktreeSummary[];
  readonly now: () => number;
  readonly formatTime: (at: number) => string;
  readonly report: (message: string) => void;
}

export interface Placed extends ProbeTarget {
  readonly path: string;
}

export class LaunchChecker {
  private readonly results = new Map<string, LaunchCheck>();
  private readonly running = new Map<string, Promise<void>>();
  /** Worktrees handed out since this window started. */
  private readonly placed = new Map<string, Placed>();
  /** Sessions that started before their repository's check was ready, by repository. */
  private readonly waiting = new Map<string, string>();

  constructor(private readonly deps: LaunchCheckerDeps) {}

  /** Checks the worktree's repository again, for the session about to start there. */
  prime(worktree: Placed): void {
    this.placed.set(worktree.path, worktree);
    if (this.deps.enabled()) {
      this.run(worktree);
    }
  }

  /** The note to add to this hook's reply, or null. */
  noteFor(payload: KnownPayload): string | null {
    const id = payload.session_id;
    const event = payload.hook_event_name;
    if (event === 'SessionEnd') {
      this.waiting.delete(id);
      return null;
    }
    if (!this.deps.enabled()) {
      return null;
    }
    if (event === 'SessionStart') {
      return this.started(id, payload.cwd ?? '');
    }
    // A subagent's context goes away with it, so the note waits for the main thread.
    const later =
      event === 'UserPromptSubmit' || (event === 'PostToolUse' && (payload.agent_id ?? '') === '');
    return later ? this.delivered(id) : null;
  }

  private started(id: string, cwd: string): string | null {
    const place = this.placeOf(cwd);
    if (place === null) {
      return null;
    }
    const result = this.results.get(place.repoRoot);
    if (result !== undefined && this.deps.now() - result.checkedAt < FRESH_MS) {
      return this.note(result);
    }
    this.run(place);
    this.waiting.set(id, place.repoRoot);
    return null;
  }

  private delivered(id: string): string | null {
    const repoRoot = this.waiting.get(id);
    if (repoRoot === undefined || this.running.has(repoRoot)) {
      return null;
    }
    this.waiting.delete(id);
    const result = this.results.get(repoRoot);
    return result === undefined ? null : this.note(result);
  }

  private note(result: LaunchCheck): string {
    return launchNote(result, this.deps.formatTime);
  }

  private run(target: ProbeTarget): void {
    const { repoRoot } = target;
    if (this.running.has(repoRoot)) {
      return;
    }
    const done = (async (): Promise<void> => {
      try {
        this.results.set(repoRoot, await this.deps.probe(target));
      } catch (error: unknown) {
        this.deps.report(`launch check failed for ${repoRoot}: ${String(error)}`);
      } finally {
        this.running.delete(repoRoot);
      }
    })();
    this.running.set(repoRoot, done);
  }

  /** The Overlord worktree holding cwd, or null for a session outside one. */
  private placeOf(cwd: string): Placed | null {
    const holds = (dir: string): boolean => cwd === dir || cwd.startsWith(dir + path.sep);
    for (const place of this.placed.values()) {
      if (holds(place.path)) {
        return place;
      }
    }
    const known = this.deps.worktrees().find((worktree) => holds(worktree.path));
    return known === undefined
      ? null
      : { path: known.path, repoRoot: known.repoRoot, target: known.target };
  }

  /** Settles once every running check has, for tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.all(this.running.values());
  }
}
