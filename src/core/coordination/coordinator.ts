// Keeps sessions in one repository from stepping on each other. It answers
// Claude Code hooks from what Overlord already knows, so it never runs git
// while a session waits:
//
// - SessionStart, and UserPromptSubmit whenever the set changed, tell a
//   session who else works in the repository and what they are changing.
// - PreToolUse pauses the first edit to a file another session is changing,
//   with the reason, so the model can steer clear or make the edit again.
// - UserPromptSubmit and PostToolUse pass on new commits on the default
//   branch that touch files this worktree changed, so it rebases early.

import path from 'node:path';

import type { WorktreeSummary } from '../../shared/protocol.js';
import { preToolUseDenyOutput } from '../hooks/mapping.js';
import type { KnownPayload } from '../hooks/payloads.js';
import type { HookOutput } from '../hooks/protocol.js';
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
}

/** A session Overlord has not heard from in this long counts as gone unless its process runs. */
export const QUIET_MS = 10 * 60_000;

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PUSH = /\bgit\b[^\n;&|]*\spush\b/u;

interface Tracked {
  cwd: string;
  topic: string | null;
  readonly edited: Set<string>;
  lastSeen: number;
}

/** The file an edit tool writes, or null for any other tool. */
function editedFile(toolName: string, input: unknown): string | null {
  if (!EDIT_TOOLS.has(toolName)) {
    return null;
  }
  const file = stringField(input, 'file_path') ?? stringField(input, 'notebook_path') ?? '';
  return file === '' ? null : file;
}

function context(event: string, notes: readonly (string | null)[]): HookOutput | null {
  const text = notes.filter((note): note is string => note !== null).join('\n\n');
  return text === ''
    ? null
    : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
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
  handle(payload: KnownPayload): HookOutput | null {
    this.observe(payload);
    if (!this.deps.enabled()) {
      return null;
    }
    const id = payload.session_id;
    const event = payload.hook_event_name;
    if (event === 'SessionStart') {
      return context(event, [this.peerNote(id, true)]);
    }
    if (event === 'UserPromptSubmit') {
      return context(event, [this.peerNote(id, false), this.landingNote(id)]);
    }
    if (event === 'PreToolUse') {
      return this.editGuard(id, payload.tool_name, payload.tool_input);
    }
    // A subagent's context goes away with it, so the notice waits for the main thread.
    if (event === 'PostToolUse' && (payload.agent_id ?? '') === '') {
      return context(event, [this.landingNote(id)]);
    }
    return null;
  }

  private observe(payload: KnownPayload): void {
    if (payload.hook_event_name === 'SessionEnd') {
      this.forget(payload.session_id);
      return;
    }
    const entry = this.track(payload.session_id, payload.cwd ?? '');
    if (entry === null) {
      return;
    }
    if (payload.hook_event_name === 'PostToolUse') {
      this.toolDone(entry, payload.tool_name, payload.tool_input);
    } else if (
      payload.hook_event_name === 'SessionStart' ||
      payload.hook_event_name === 'UserPromptSubmit'
    ) {
      // A title wins over the first prompt, which only fills in until one arrives.
      const prompt = payload.hook_event_name === 'UserPromptSubmit' ? payload.prompt : '';
      entry.topic = topicOf(payload.session_title ?? '') ?? entry.topic ?? topicOf(prompt);
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
  private toolDone(entry: Tracked, toolName: string, input: unknown): void {
    const file = editedFile(toolName, input);
    if (file !== null) {
      entry.edited.add(path.resolve(entry.cwd, file));
    }
    const command = toolName === 'Bash' ? stringField(input, 'command') : null;
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
  private where(id: string): { readonly self: Workspace; readonly all: Workspace[] } | null {
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

  private editGuard(id: string, toolName: string, input: unknown): HookOutput | null {
    const raw = editedFile(toolName, input);
    const found = raw === null ? null : this.where(id);
    if (raw === null || found === null) {
      return null;
    }
    const file = path.resolve(this.sessions.get(id)?.cwd ?? '', raw);
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
    return preToolUseDenyOutput(editWarning(relative, peers));
  }
}
