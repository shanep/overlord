// Keeps sessions in one repository from stepping on each other. It answers
// agent hooks from what Overlord already knows, so it never runs git while a
// session waits:
//
// - SessionStart, and UserPromptSubmit whenever the set changed, tell a
//   session who else works in the repository and what they are changing.
// - PreToolUse pauses the first edit to a file another session is changing,
//   with the reason, so the model can steer clear or make the edit again.
// - UserPromptSubmit and PostToolUse pass on new commits on the default
//   branch that touch files this worktree changed, so it rebases early.

import path from 'node:path';

import type { AgentId } from '../../shared/agents.js';
import type { WorktreeSummary } from '../../shared/protocol.js';
import type {
  EditTools,
  HookAnswer,
  HookToolCall,
  NormalizedHookEvent,
} from '../hooks/normalized.js';
import { editedFiles } from '../hooks/normalized.js';
import { stringField } from '../hooks/rules.js';

import { editWarning, landingNotice, peerContext, topicOf } from './notes.js';
import type { TrackedSession, Workspace } from './workspaces.js';
import { buildWorkspaces, peersOf, workspaceFor, workspaceOfFile } from './workspaces.js';

export interface CoordinatorDeps {
  /** False turns every answer off. Read on each hook. */
  readonly enabled: () => boolean;
  readonly worktrees: () => readonly WorktreeSummary[];
  /** Busy, idle or waiting by session id, as Claude Code reports it. */
  readonly statuses: () => Readonly<Record<string, string>>;
  /** True while the session's process runs. */
  readonly isLive: (sessionId: string) => boolean;
  /** Asks for fresh worktree status, after a session pushed. */
  readonly refresh: () => void;
  readonly now: () => number;
  /** The tools that write files for an agent, from its hooks facet. */
  readonly editTools: (agent: AgentId) => EditTools;
}

/** A session Overlord has not heard from in this long counts as gone unless its process runs. */
export const QUIET_MS = 10 * 60_000;

const PUSH = /\bgit\b[^\n;&|]*\spush\b/u;

interface Tracked {
  cwd: string;
  topic: string | null;
  readonly edited: Set<string>;
  lastSeen: number;
}

function context(notes: readonly (string | null)[]): HookAnswer | null {
  const text = notes.filter((note): note is string => note !== null).join('\n\n');
  return text === '' ? null : { context: text };
}

/** Who is there and what they work on, not what they changed, so edits alone do not repeat the note. */
function fingerprint(peers: readonly Workspace[]): string {
  return peers
    .map((peer) =>
      [peer.key, ...peer.sessions.map((session) => session.topic ?? '')].join('\u0001'),
    )
    .toSorted((a, b) => a.localeCompare(b))
    .join('\u0000');
}

/** A session's own workspace and every workspace in its repository. */
interface Placed {
  readonly self: Workspace;
  readonly all: Workspace[];
}

export class Coordinator {
  private readonly sessions = new Map<string, Tracked>();
  /** The peer fingerprint each session was last told. */
  private readonly told = new Map<string, string>();
  /** Session, file and peers of every edit already paused once. */
  private readonly paused = new Set<string>();
  /** Files each session already heard the default branch changed. */
  private readonly noticed = new Map<string, Set<string>>();

  constructor(private readonly deps: CoordinatorDeps) {}

  /** Records what the hook says about its session and returns what to answer, or null. */
  handle(event: NormalizedHookEvent): HookAnswer | null {
    this.observe(event);
    if (!this.deps.enabled()) {
      return null;
    }
    const id = event.sessionId;
    if (event.kind === 'session-start') {
      return context([this.peerNote(id, true)]);
    }
    if (event.kind === 'prompt-submit') {
      return context([this.peerNote(id, false), this.landingNote(id)]);
    }
    if (event.kind === 'pre-tool-use') {
      return this.editGuard(id, event.agent, event.tool);
    }
    // A subagent's context goes away with it, so the notice waits for the main thread.
    if (event.kind === 'post-tool-use' && event.subagentId === null) {
      return context([this.landingNote(id)]);
    }
    return null;
  }

  private observe(event: NormalizedHookEvent): void {
    if (event.kind === 'session-end') {
      this.forget(event.sessionId);
      return;
    }
    const entry = this.track(event.sessionId, event.cwd ?? '');
    if (entry === null) {
      return;
    }
    if (event.kind === 'post-tool-use') {
      this.toolDone(entry, event.agent, event.tool);
    } else if (event.kind === 'session-start' || event.kind === 'prompt-submit') {
      // A title wins over the first prompt, which only fills in until one arrives.
      const prompt = event.kind === 'prompt-submit' ? event.prompt : '';
      entry.topic = topicOf(event.title ?? '') ?? entry.topic ?? topicOf(prompt);
    }
  }

  /** The session's entry, made or updated now, or null for a session with no folder yet. */
  private track(id: string, cwd: string): Tracked | null {
    const tracked = this.sessions.get(id);
    if (tracked === undefined && cwd === '') {
      return null;
    }
    const entry: Tracked = tracked ?? { cwd, topic: null, edited: new Set(), lastSeen: 0 };
    this.sessions.set(id, entry);
    entry.lastSeen = this.deps.now();
    if (cwd !== '') {
      entry.cwd = cwd;
    }
    return entry;
  }

  /** Remembers an edited file, and asks for fresh status after a push. */
  private toolDone(entry: Tracked, agent: AgentId, tool: HookToolCall): void {
    for (const file of editedFiles(this.deps.editTools(agent), tool)) {
      entry.edited.add(path.resolve(entry.cwd, file));
    }
    const command = tool.name === 'Bash' ? stringField(tool.input, 'command') : null;
    if (command !== null && PUSH.test(command)) {
      this.deps.refresh();
    }
  }

  private forget(id: string): void {
    this.sessions.delete(id);
    this.told.delete(id);
    this.noticed.delete(id);
    for (const key of this.paused) {
      if (key.startsWith(`${id}\u0000`)) {
        this.paused.delete(key);
      }
    }
  }

  /** The sessions that still count, dropping ones gone quiet with no process. */
  private tracked(): TrackedSession[] {
    const now = this.deps.now();
    const statuses = this.deps.statuses();
    const sessions: TrackedSession[] = [];
    for (const [sessionId, entry] of this.sessions) {
      if (!this.deps.isLive(sessionId) && now - entry.lastSeen > QUIET_MS) {
        this.forget(sessionId);
        continue;
      }
      sessions.push({
        sessionId,
        cwd: entry.cwd,
        topic: entry.topic,
        status: statuses[sessionId] ?? null,
        edited: [...entry.edited],
      });
    }
    return sessions;
  }

  /** The session's workspace and every workspace in play, or null outside a known repository. */
  private where(id: string): Placed | null {
    const entry = this.sessions.get(id);
    if (entry === undefined) {
      return null;
    }
    const worktrees = this.deps.worktrees();
    const all = buildWorkspaces(worktrees, this.tracked());
    const place = workspaceFor(entry.cwd, worktrees);
    const self = all.find((item) => item.key === place?.key);
    return self === undefined ? null : { self, all };
  }

  private peerNote(id: string, always: boolean): string | null {
    const found = this.where(id);
    const peers = found === null ? [] : peersOf(found.self, found.all);
    const print = fingerprint(peers);
    const before = this.told.get(id);
    this.told.set(id, print);
    if (peers.length === 0 || (!always && before === print)) {
      return null;
    }
    return peerContext(peers);
  }

  private landingNote(id: string): string | null {
    const self = this.where(id)?.self ?? null;
    const target = self?.target ?? null;
    if (self === null || target === null) {
      return null;
    }
    const { upstreamFiles } = self;
    if (upstreamFiles.length === 0) {
      // Rebased, or nothing landed: the next landing gets its own notice.
      this.noticed.delete(id);
      return null;
    }
    const heard = this.noticed.get(id) ?? new Set<string>();
    const fresh = upstreamFiles.filter((file) => !heard.has(file));
    if (fresh.length === 0) {
      return null;
    }
    this.noticed.set(id, new Set([...heard, ...fresh]));
    return landingNotice(target, fresh);
  }

  private editGuard(id: string, agent: AgentId, tool: HookToolCall): HookAnswer | null {
    const files = editedFiles(this.deps.editTools(agent), tool);
    const found = files.length === 0 ? null : this.where(id);
    if (found === null) {
      return null;
    }
    const cwd = this.sessions.get(id)?.cwd ?? '';
    // A patch can write many files, so one pause names every file a peer is changing.
    const warnings = files.flatMap((raw) => this.pauseFor(id, path.resolve(cwd, raw), found) ?? []);
    return warnings.length === 0 ? null : { block: warnings.join('\n\n') };
  }

  /** The warning for an edit to a file a peer is changing, the first time only, or null. */
  private pauseFor(id: string, file: string, found: Placed): string | null {
    const home = workspaceOfFile(file, found.all) ?? found.self;
    const relative = path.relative(home.root, file);
    if (relative.startsWith('..')) {
      return null;
    }
    const peers = peersOf(home, found.all).filter((peer) => peer.files.includes(relative));
    if (peers.length === 0) {
      return null;
    }
    const key = [id, home.key, relative, ...peers.map((peer) => peer.key)].join('\u0000');
    if (this.paused.has(key)) {
      return null;
    }
    this.paused.add(key);
    return editWarning(relative, peers);
  }
}
