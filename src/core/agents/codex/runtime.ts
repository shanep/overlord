// Codex CLI's runtime: one `codex app-server` process per session, driven
// over JSON-RPC on its stdio. It is the only Codex driver that answers
// approvals, interrupts a turn and reports rate limits. Codex mints the
// thread id, so the run reports it once thread/start returns. Profile
// settings go in as `-c key=value` and thread params, never into config.toml.

import { AsyncQueue } from '../../harness/input-queue.js';
import { configArgs } from '../../knobs/launch.js';
import type { AgentEvent } from '../shared/events.js';
import type {
  AgentRun,
  RuntimeFacet,
  StartOptions,
  ToolPermissionHandler,
  ToolPermissionResult,
} from '../shared/runtime.js';

import {
  CodexTranslator,
  initEvent,
  rateLimitEvent,
  threadResultSchema,
  turnResultSchema,
} from './app-server.js';
import { approvalAsk, approvalReply } from './approvals.js';
import { CODEX_PERMISSION_MODES } from './capabilities.js';
import {
  NOT_HANDLED,
  RpcClosedError,
  RpcConnection,
  spawnAppServer,
  type AppServerExit,
  type AppServerProcess,
  type AppServerSpawn,
  type RpcReply,
} from './rpc.js';

/** How long a server with its stdin closed gets to exit before it is killed. */
const EXIT_GRACE_MS = 3000;

/** Codex's sandbox_mode values as the sandboxPolicy a turn takes. */
const SANDBOX_POLICIES: Readonly<Record<string, unknown>> = {
  'read-only': { type: 'readOnly', networkAccess: false },
  'workspace-write': {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  'danger-full-access': { type: 'dangerFullAccess' },
};

interface Permission {
  readonly approvalPolicy: string;
  readonly sandbox: string;
}

/** One of Codex's mode ids, "approval/sandbox", split into its two settings. */
function splitMode(mode: string): Permission {
  const [approvalPolicy, sandbox] = mode.split('/');
  if (
    approvalPolicy === undefined ||
    sandbox === undefined ||
    !CODEX_PERMISSION_MODES.some((option) => option.id === mode)
  ) {
    throw new Error(`Unknown permission mode "${mode}"`);
  }
  return { approvalPolicy, sandbox };
}

/** The app-server's argv: effort as a config override, then the profile's own flags. */
export function appServerArgs(options: StartOptions): string[] {
  const effort =
    options.effort === null
      ? []
      : configArgs([{ key: ['model_reasoning_effort'], value: options.effort }]);
  const extra = Object.entries(options.extraArgs).flatMap(([flag, value]) =>
    value === null ? [`--${flag}`] : [`--${flag}`, value],
  );
  return ['app-server', ...effort, ...extra];
}

/** The request that opens the thread: start, resume, or fork into a new one. */
export function threadRequest(options: StartOptions): {
  readonly method: string;
  readonly params: Record<string, unknown>;
} {
  const permission = options.permissionMode === null ? null : splitMode(options.permissionMode);
  const settings = {
    cwd: options.cwd,
    ...(options.model === null ? {} : { model: options.model }),
    ...(permission === null
      ? {}
      : { approvalPolicy: permission.approvalPolicy, sandbox: permission.sandbox }),
  };
  if (options.resumeId === null) {
    return { method: 'thread/start', params: settings };
  }
  // The history comes back page by page on request, so the reply leaves it out.
  return {
    method: options.fork ? 'thread/fork' : 'thread/resume',
    params: { threadId: options.resumeId, excludeTurns: true, ...settings },
  };
}

function exitMessage(exit: AppServerExit): string {
  const said = exit.stderr.trim().split('\n').slice(-3).join(' ');
  if (exit.code === null && exit.signal === null) {
    return `codex app-server could not start: ${said}`;
  }
  const how = exit.signal === null ? `with code ${String(exit.code)}` : `on ${exit.signal}`;
  const why = said === '' ? '' : `: ${said}`;
  return `codex app-server exited ${how}${why}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The thread id a notification names, so a subagent's thread does not end this one's turn. */
function threadOf(params: unknown): string | null {
  return typeof params === 'object' &&
    params !== null &&
    'threadId' in params &&
    typeof params.threadId === 'string'
    ? params.threadId
    : null;
}

interface Turn {
  /** Null until turn/start answers. */
  id: string | null;
  /** Interrupt asked for before the id was known. */
  interrupt: boolean;
}

/** What the next turn/start changes, from setModel and setPermissionMode. */
interface TurnOverrides {
  model?: string;
  approvalPolicy?: string;
  sandboxPolicy?: unknown;
}

/** One Codex thread on its own app-server. Prompts queue and run one turn at a time. */
class CodexRun implements AgentRun {
  sessionId: string | null = null;
  private readonly events = new AsyncQueue<AgentEvent>();
  private readonly process: AppServerProcess;
  private readonly rpc: RpcConnection;
  private readonly canUseTool: ToolPermissionHandler;
  private readonly approvals = new Map<number | string, AbortController>();
  private readonly prompts: string[] = [];
  private translator: CodexTranslator | null = null;
  private turn: Turn | null = null;
  private overrides: TurnOverrides = {};
  private failure: Error | null = null;
  private inputEnded = false;
  private closing = false;
  private stopped = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(spawn: AppServerSpawn, options: StartOptions) {
    this.canUseTool = options.canUseTool;
    // maxBudgetUsd has nothing to stop on, since Codex reports no dollars.
    this.process = spawn({
      command: options.executablePath ?? 'codex',
      args: appServerArgs(options),
      cwd: options.cwd,
      env: options.env,
    });
    this.rpc = new RpcConnection(this.process, {
      notification: (method, params): void => {
        this.notified(method, params);
      },
      request: async (method, params, id): Promise<RpcReply> => this.asked(method, params, id),
    });
  }

  /** Starts reading the server and opens the thread. The constructor only spawns. */
  begin(open: ReturnType<typeof threadRequest>): this {
    void this.watch();
    void this.boot(open);
    return this;
  }

  readonly send = (text: string): void => {
    this.prompts.push(text);
    this.next();
  };

  readonly endInput = (): void => {
    this.inputEnded = true;
    this.next();
  };

  readonly interrupt = async (): Promise<void> => {
    const { turn, sessionId } = this;
    if (turn === null || sessionId === null) {
      return;
    }
    if (turn.id === null) {
      turn.interrupt = true;
      return;
    }
    await this.rpc.request('turn/interrupt', { threadId: sessionId, turnId: turn.id });
  };

  readonly stop = (): void => {
    this.stopped = true;
    this.process.kill();
    this.finish();
  };

  /** Takes effect from the next turn, since a turn keeps the model it started with. */
  readonly setModel = async (model: string): Promise<void> => {
    await Promise.resolve();
    this.overrides = { ...this.overrides, model };
  };

  /** Takes effect from the next turn, like setModel. */
  readonly setPermissionMode = async (mode: string): Promise<void> => {
    await Promise.resolve();
    const { approvalPolicy, sandbox } = splitMode(mode);
    this.overrides = {
      ...this.overrides,
      approvalPolicy,
      sandboxPolicy: SANDBOX_POLICIES[sandbox],
    };
  };

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent, undefined, undefined> {
    yield* this.events;
    if (this.failure !== null) {
      throw this.failure;
    }
    return undefined;
  }

  private async boot(open: ReturnType<typeof threadRequest>): Promise<void> {
    try {
      await this.rpc.request('initialize', {
        clientInfo: { name: 'overlord', title: 'Overlord', version: '1' },
      });
      this.rpc.notify('initialized');
      const thread = threadResultSchema.parse(await this.rpc.request(open.method, open.params));
      this.translator = new CodexTranslator(thread.model);
      this.sessionId = thread.thread.id;
      this.emit(
        initEvent(
          thread,
          CODEX_PERMISSION_MODES.map((mode) => mode.id),
        ),
      );
      void this.readLimits();
      this.next();
    } catch (error) {
      this.failed(error);
    }
  }

  /** The limits as they stand, so the Fleet has them before the first call reports. */
  private async readLimits(): Promise<void> {
    try {
      const event = rateLimitEvent(await this.rpc.request('account/rateLimits/read', null));
      if (event !== null) {
        this.emit(event);
      }
    } catch {
      // An API key account has no plan limits to read.
    }
  }

  /** Waits for the server's output to end and the process to exit, then ends the run. */
  private async watch(): Promise<void> {
    const [, exit] = await Promise.all([this.rpc.read().catch(() => null), this.process.exited]);
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
    }
    if (this.stopped || this.closing) {
      this.finish();
    } else {
      this.fail(new Error(exitMessage(exit)));
    }
  }

  private next(): void {
    const threadId = this.sessionId;
    if (threadId === null || this.turn !== null || this.events.ended) {
      return;
    }
    const text = this.prompts.shift();
    if (text === undefined) {
      if (this.inputEnded) {
        this.shutdown();
      }
      return;
    }
    const turn: Turn = { id: null, interrupt: false };
    this.turn = turn;
    void this.startTurn(threadId, turn, text);
  }

  private async startTurn(threadId: string, turn: Turn, text: string): Promise<void> {
    const { overrides } = this;
    this.overrides = {};
    if (overrides.model !== undefined) {
      this.translator?.setModel(overrides.model);
    }
    try {
      const raw = await this.rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
        ...overrides,
      });
      turn.id = turnResultSchema.parse(raw).turn.id;
      if (turn.interrupt) {
        await this.interrupt();
      }
    } catch (error) {
      if (error instanceof RpcClosedError || this.turn !== turn) {
        return;
      }
      this.emit({
        type: 'turn_result',
        ok: false,
        subtype: 'error',
        text: messageOf(error),
        costUsd: null,
        turns: null,
        durationMs: null,
        usage: null,
      });
      this.turnEnded();
    }
  }

  private turnEnded(): void {
    this.turn = null;
    this.next();
  }

  private notified(method: string, params: unknown): void {
    const translator = this.translator;
    const thread = threadOf(params);
    if (translator === null || (thread !== null && thread !== this.sessionId)) {
      return;
    }
    if (method === 'serverRequest/resolved') {
      this.resolved(params);
      return;
    }
    for (const event of translator.notification(method, params)) {
      this.emit(event);
    }
    if (method === 'turn/completed') {
      this.turnEnded();
    }
  }

  /** The server settled an approval itself, as an interrupt does, so the inbox stops asking. */
  private resolved(params: unknown): void {
    if (typeof params === 'object' && params !== null && 'requestId' in params) {
      const { requestId } = params;
      if (typeof requestId === 'number' || typeof requestId === 'string') {
        this.approvals.get(requestId)?.abort();
      }
    }
  }

  private async asked(method: string, params: unknown, id: number | string): Promise<RpcReply> {
    const ask = this.translator === null ? null : approvalAsk(method, params, this.translator);
    if (ask === null) {
      return { error: { code: NOT_HANDLED, message: `Overlord does not answer ${method}` } };
    }
    const abort = new AbortController();
    this.approvals.set(id, abort);
    let result: ToolPermissionResult;
    try {
      result = await this.canUseTool(ask.toolName, ask.input, {
        signal: abort.signal,
        toolUseId: ask.toolUseId,
        agentId: null,
      });
    } catch (error) {
      result = { behavior: 'deny', message: messageOf(error) };
    } finally {
      this.approvals.delete(id);
    }
    return { result: approvalReply(method, params, result) };
  }

  /** No more prompts and none running: close stdin so the server exits, and kill it if it lingers. */
  private shutdown(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.process.closeInput();
    const timer = setTimeout(() => {
      this.process.kill();
    }, EXIT_GRACE_MS);
    timer.unref();
    this.killTimer = timer;
  }

  private emit(event: AgentEvent): void {
    if (!this.events.ended) {
      this.events.push(event);
    }
  }

  /** A failure while starting. A closed server is left to its exit, which says why. */
  private failed(error: unknown): void {
    if (!(error instanceof RpcClosedError)) {
      this.fail(error instanceof Error ? error : new Error(messageOf(error)));
    }
  }

  private fail(error: Error): void {
    if (this.events.ended) {
      return;
    }
    this.failure = error;
    this.process.kill();
    this.finish();
  }

  private finish(): void {
    for (const abort of this.approvals.values()) {
      abort.abort();
    }
    this.events.end();
  }
}

/** The Codex runtime over a spawn function, the real `codex app-server` unless a test passes a fake. */
export function codexRuntime(spawn: AppServerSpawn = spawnAppServer): RuntimeFacet {
  return {
    start: (options): AgentRun => {
      // Checked first, so a bad mode fails the run before anything starts.
      const open = threadRequest(options);
      return new CodexRun(spawn, options).begin(open);
    },
    permissionSource: 'runtime',
  };
}
