// The extension side of the hook bridge. Every Claude Code hook runs the
// overlord-hook script, which forwards its stdin here over a local socket and
// prints whatever we answer. Only PermissionRequest waits for an answer; every
// other event is acknowledged at once so hooks never slow a session down.
// SendMessage never asks permission, so its deny rules are applied on
// PreToolUse instead. PreToolUse only ever denies; it never allows anything.

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import type { PermissionDecision, PermissionRequest } from '../../shared/model.js';
import type { AutoApproveRule } from '../../shared/protocol.js';
import type { EventBus } from '../bus.js';

import type { AuditEntry } from './audit.js';
import type { InstructionLoadedEvent } from './mapping.js';
import {
  permissionOutput,
  preToolUseDenyOutput,
  ruleDenyMessage,
  sessionStartOutput,
  toAgentNode,
  toInstructionLoaded,
  toPermissionRequest,
} from './mapping.js';
import type {
  KnownPayload,
  ParsedHookPayload,
  PermissionRequestPayload,
  SubagentStartPayload,
  SubagentStopPayload,
} from './payloads.js';
import { parseHookPayload } from './payloads.js';
import type { HookOutput } from './protocol.js';
import { encodeMessage, LineDecoder, MAX_LINE_BYTES, parseRequestLine } from './protocol.js';
import { findMatchingRule, SEND_MESSAGE_TOOL } from './rules.js';

export { socketPath } from './socket-path.js';

/** Ten minutes, the same as the PermissionRequest hook timeout the installer writes. */
export const DEFAULT_HOLD_MS = 10 * 60 * 1000;

export interface HookServerOptions {
  readonly socketPath: string;
  readonly bus: EventBus;
  readonly rules?: readonly AutoApproveRule[];
  readonly audit?: AuditSink | null;
  /** How long a PermissionRequest waits for resolvePermission before Claude Code shows its own prompt. */
  readonly holdMs?: number;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly platform?: NodeJS.Platform;
  /** Longest hook message accepted before the connection is dropped. */
  readonly maxLineBytes?: number;
  /** Text every new session gets from its SessionStart hook, or null for none. Must not block. */
  readonly sessionContext?: () => string | null;
}

export interface HookEvent {
  readonly receivedAt: number;
  readonly hook: ParsedHookPayload;
}

type Callback<T> = (value: T) => void;

/** Where auto decisions are recorded. AuditLog fits. */
export interface AuditSink {
  readonly append: (entry: AuditEntry) => Promise<void>;
}

interface Pending {
  readonly request: PermissionRequest;
  readonly socket: net.Socket;
  readonly messageId: string;
  readonly timer: NodeJS.Timeout;
}

const SOURCE = 'hooks';

type PreToolUsePayload = Extract<KnownPayload, { readonly hook_event_name: 'PreToolUse' }>;

/** Tools that run without a permission prompt, so deny rules must act on PreToolUse. */
const PRE_TOOL_DENY_TOOLS: ReadonlySet<string> = new Set([SEND_MESSAGE_TOOL]);

async function isLive(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(file);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      resolve(false);
    });
  });
}

/** Creates the socket directory (0700) and removes a socket file nobody is listening on. */
export async function prepareSocketPath(file: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (await isLive(file)) {
    throw new Error(`another Overlord hook server is already listening on ${file}`);
  }
  await rm(file, { force: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HookServer {
  readonly socketPath: string;
  private readonly bus: EventBus;
  private readonly audit: AuditSink | null;
  private readonly holdMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly maxLineBytes: number;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<Callback<HookEvent>>();
  private readonly instructionListeners = new Set<Callback<InstructionLoadedEvent>>();
  private readonly agentStarts = new Map<string, number>();
  private readonly sessionContext: () => string | null;
  private rules: readonly AutoApproveRule[];

  constructor(options: HookServerOptions) {
    this.socketPath = options.socketPath;
    this.bus = options.bus;
    this.rules = options.rules ?? [];
    this.audit = options.audit ?? null;
    this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.platform = options.platform ?? process.platform;
    this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
    this.sessionContext = options.sessionContext ?? ((): null => null);
    this.server = net.createServer((socket) => {
      this.accept(socket);
    });
  }

  async start(): Promise<void> {
    await prepareSocketPath(this.socketPath, this.platform);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  /** Stops listening. Held permission requests are released, so Claude Code falls back to its own prompt. */
  async stop(): Promise<void> {
    for (const entry of this.pending.values()) {
      this.finish(entry, null);
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** Every hook event, parsed, as it arrives. */
  onEvent(callback: Callback<HookEvent>): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  onInstructionLoaded(callback: Callback<InstructionLoadedEvent>): () => void {
    this.instructionListeners.add(callback);
    return () => this.instructionListeners.delete(callback);
  }

  setRules(rules: readonly AutoApproveRule[]): void {
    this.rules = rules;
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  /** Answers a held PermissionRequest. False when it already timed out, was answered, or its session went away. */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) {
      return false;
    }
    this.finish(entry, permissionOutput(decision));
    return true;
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    const decoder = new LineDecoder(this.maxLineBytes);
    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        this.report(errorMessage(error));
        socket.destroy();
        return;
      }
      for (const line of lines) {
        this.handleLine(socket, line);
      }
    });
    // A hook killed by Claude Code (timeout, or the user answered in the
    // terminal) closes the socket. Nothing else to clean up for the error.
    socket.on('error', () => {
      // Handled by the close event below.
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      for (const entry of this.pending.values()) {
        if (entry.socket === socket) {
          this.finish(entry, null);
        }
      }
    });
  }

  private handleLine(socket: net.Socket, line: string): void {
    const message = parseRequestLine(line);
    if (message === null) {
      this.report('hook script sent a message that is not a request');
      return;
    }
    const parsed = parseHookPayload(message.event);
    if (!parsed.ok) {
      this.report(`invalid hook payload: ${parsed.error}`);
      this.reply(socket, message.id, {});
      return;
    }
    const hook = parsed.value;
    this.safely(() => {
      const event: HookEvent = { receivedAt: this.now(), hook };
      for (const listener of this.eventListeners) {
        listener(event);
      }
    });
    if (hook.known && hook.payload.hook_event_name === 'PermissionRequest') {
      this.handlePermission(socket, message.id, hook.payload);
      return;
    }
    if (hook.known) {
      this.safely(() => {
        this.publish(hook.payload);
      });
    }
    this.reply(socket, message.id, (hook.known ? this.outputFor(hook.payload) : null) ?? {});
  }

  /** What a hook prints: a deny on PreToolUse, the session note on SessionStart, else nothing. */
  private outputFor(payload: KnownPayload): HookOutput | null {
    if (payload.hook_event_name === 'PreToolUse') {
      return this.preToolDeny(payload);
    }
    if (payload.hook_event_name !== 'SessionStart') {
      return null;
    }
    try {
      const text = this.sessionContext();
      return text === null ? null : sessionStartOutput(text);
    } catch (error) {
      this.report(`session note failed: ${errorMessage(error)}`);
      return null;
    }
  }

  /** The deny output when a deny rule covers a tool that never prompts, else null. */
  private preToolDeny(payload: PreToolUsePayload): HookOutput | null {
    if (!PRE_TOOL_DENY_TOOLS.has(payload.tool_name)) {
      return null;
    }
    const rule = findMatchingRule(this.rules, payload.tool_name, payload.tool_input);
    if (rule?.behavior !== 'deny') {
      return null;
    }
    this.record(toPermissionRequest(payload, this.newId(), this.now()), rule.id, 'deny');
    return preToolUseDenyOutput(ruleDenyMessage(rule.id, rule.description));
  }

  private publish(payload: KnownPayload): void {
    if (payload.hook_event_name === 'InstructionsLoaded') {
      const event = toInstructionLoaded(payload, this.now());
      for (const listener of this.instructionListeners) {
        listener(event);
      }
      return;
    }
    if (payload.hook_event_name === 'SubagentStart' || payload.hook_event_name === 'SubagentStop') {
      this.publishAgent(payload);
    }
  }

  private publishAgent(payload: SubagentStartPayload | SubagentStopPayload): void {
    const key = `${payload.session_id}\u0000${payload.agent_id}`;
    const now = this.now();
    if (payload.hook_event_name === 'SubagentStart') {
      // A resumed subagent fires SubagentStart again; keep the first start time.
      const startedAt = this.agentStarts.get(key) ?? now;
      this.agentStarts.set(key, startedAt);
      this.bus.emit('agent.upserted', toAgentNode(payload, { startedAt, endedAt: null }));
      return;
    }
    const startedAt = this.agentStarts.get(key) ?? now;
    this.agentStarts.delete(key);
    this.bus.emit('agent.upserted', toAgentNode(payload, { startedAt, endedAt: now }));
  }

  private handlePermission(
    socket: net.Socket,
    messageId: string,
    payload: PermissionRequestPayload,
  ): void {
    const request = toPermissionRequest(payload, this.newId(), this.now());
    const rule = findMatchingRule(this.rules, request.toolName, request.input);
    if (rule !== null) {
      const decision: PermissionDecision =
        rule.behavior === 'allow'
          ? { behavior: 'allow', ruleId: rule.id }
          : {
              behavior: 'deny',
              ruleId: rule.id,
              message: ruleDenyMessage(rule.id, rule.description),
            };
      this.reply(socket, messageId, permissionOutput(decision));
      this.record(request, rule.id, rule.behavior);
      return;
    }
    const entry: Pending = {
      request,
      socket,
      messageId,
      timer: setTimeout(() => {
        this.finish(entry, {});
      }, this.holdMs),
    };
    this.pending.set(request.id, entry);
    this.safely(() => {
      this.bus.emit('permission.requested', request);
    });
  }

  private record(request: PermissionRequest, ruleId: string, behavior: 'allow' | 'deny'): void {
    if (this.audit === null) {
      return;
    }
    const entry: AuditEntry = {
      at: request.requestedAt,
      requestId: request.id,
      sessionId: request.sessionId,
      agentId: request.agentId,
      toolName: request.toolName,
      ruleId,
      behavior,
    };
    this.audit.append(entry).catch((error: unknown) => {
      this.report(`audit log write failed: ${errorMessage(error)}`);
    });
  }

  /** Drops a held request. A null output means the hook has gone, so nothing is written. */
  private finish(entry: Pending, output: HookOutput | null): void {
    clearTimeout(entry.timer);
    this.pending.delete(entry.request.id);
    if (output !== null) {
      this.reply(entry.socket, entry.messageId, output);
    }
    this.safely(() => {
      this.bus.emit('permission.resolved', { requestId: entry.request.id });
    });
  }

  private reply(socket: net.Socket, id: string, output: HookOutput): void {
    // A write to a socket the hook already closed fails through the socket's
    // error event, which accept() ignores.
    socket.write(encodeMessage({ id, output }));
  }

  private safely(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.report(`hook listener failed: ${errorMessage(error)}`);
    }
  }

  private report(message: string): void {
    try {
      this.bus.emit('source.error', { source: SOURCE, message });
    } catch {
      // A failing error listener must not take the server down.
    }
  }
}
