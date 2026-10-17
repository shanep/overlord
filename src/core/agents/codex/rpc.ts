// JSON-RPC over the stdio of `codex app-server`, one message per line. The
// server leaves out "jsonrpc" and numbers its own requests from 0, apart from
// ours, so a message is told apart by its fields: method and id is a server
// request, method alone a notification, and id alone a reply to us.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { z } from 'zod';

/** How the app-server process ended. */
export interface AppServerExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** The end of what it wrote to stderr, or why it could not start. */
  readonly stderr: string;
}

/** One running app-server, as the runtime talks to it. Tests pass a fake one. */
export interface AppServerProcess {
  /** Writes one message. The line break is added here. */
  readonly write: (line: string) => void;
  /** What the server writes to stdout, line by line, until it exits. */
  readonly lines: AsyncIterable<string, unknown, undefined>;
  readonly exited: Promise<AppServerExit>;
  /** Closes stdin, which makes the server exit once it is idle. */
  readonly closeInput: () => void;
  readonly kill: () => void;
}

export interface AppServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type AppServerSpawn = (launch: AppServerLaunch) => AppServerProcess;

const STDERR_KEEP = 4000;

/** A write after the server died fails with EPIPE, and its exit already says what went wrong. */
function ignoreWriteError(): void {
  // Nothing to do.
}

/** The real spawn. A .js or .mjs path runs with this Node, so a script can stand in for codex. */
export const spawnAppServer: AppServerSpawn = (launch) => {
  const script = /\.m?js$/u.test(launch.command);
  const child = spawn(
    script ? process.execPath : launch.command,
    script ? [launch.command, ...launch.args] : [...launch.args],
    { cwd: launch.cwd, env: { ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_KEEP);
  });
  child.stdin.on('error', ignoreWriteError);
  const exited = new Promise<AppServerExit>((resolve) => {
    child.on('error', (error) => {
      resolve({ code: null, signal: null, stderr: error.message });
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
  return {
    write: (line): void => {
      if (child.stdin.writable) {
        child.stdin.write(`${line}\n`);
      }
    },
    lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
    exited,
    closeInput: (): void => {
      child.stdin.end();
    },
    kill: (): void => {
      child.kill('SIGTERM');
    },
  };
};

const idSchema = z.union([z.number(), z.string()]);

const messageSchema = z.object({
  id: idSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

type RpcId = z.infer<typeof idSchema>;

/** What a server request gets back: a result, or an error the server sees as a failed request. */
export type RpcReply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

export interface RpcHandlers {
  readonly notification: (method: string, params: unknown) => void;
  readonly request: (method: string, params: unknown, id: RpcId) => Promise<RpcReply>;
}

/** An error reply from the server, with its JSON-RPC code. */
export class RpcError extends Error {
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message}`);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** What every open request rejects with once the server stops writing. Its exit says why. */
export class RpcClosedError extends Error {
  constructor() {
    super('codex app-server closed its output');
    this.name = 'RpcClosedError';
  }
}

interface Pending {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** Method not found, the JSON-RPC code for a request Overlord does not answer. */
export const NOT_HANDLED = -32_601;

export class RpcConnection {
  private readonly process: AppServerProcess;
  private readonly handlers: RpcHandlers;
  private readonly pending = new Map<RpcId, Pending>();
  private nextId = 1;
  private closed: Error | null = null;

  constructor(process: AppServerProcess, handlers: RpcHandlers) {
    this.process = process;
    this.handlers = handlers;
  }

  /** Sends a request and resolves with its result, or rejects with its error. */
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed !== null) {
      throw this.closed;
    }
    const id = this.nextId;
    this.nextId += 1;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    this.process.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return answer;
  }

  notify(method: string): void {
    this.process.write(JSON.stringify({ jsonrpc: '2.0', method }));
  }

  /** Reads the server until its stdout ends, then fails every request still open. */
  async read(): Promise<void> {
    try {
      for await (const line of this.process.lines) {
        this.receive(line);
      }
    } finally {
      this.close(new RpcClosedError());
    }
  }

  private close(error: Error): void {
    this.closed = error;
    for (const waiting of this.pending.values()) {
      waiting.reject(error);
    }
    this.pending.clear();
  }

  private receive(line: string): void {
    if (line.trim() === '') {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // Not a message, such as a log line. Codex keeps its logs on stderr, so this is rare.
      return;
    }
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.method !== undefined && message.id !== undefined) {
      void this.answer(message.method, message.params, message.id);
    } else if (message.method === undefined) {
      this.settle(message.id, message.result, message.error);
    } else {
      this.handlers.notification(message.method, message.params);
    }
  }

  private settle(
    id: RpcId | undefined,
    result: unknown,
    error: { readonly code: number; readonly message: string } | undefined,
  ): void {
    const waiting = id === undefined ? undefined : this.pending.get(id);
    if (id === undefined || waiting === undefined) {
      return;
    }
    this.pending.delete(id);
    if (error === undefined) {
      waiting.resolve(result);
    } else {
      waiting.reject(new RpcError(waiting.method, error.code, error.message));
    }
  }

  private async answer(method: string, params: unknown, id: RpcId): Promise<void> {
    let reply: RpcReply;
    try {
      reply = await this.handlers.request(method, params, id);
    } catch (error) {
      reply = {
        error: { code: NOT_HANDLED, message: error instanceof Error ? error.message : 'failed' },
      };
    }
    this.process.write(JSON.stringify({ jsonrpc: '2.0', id, ...reply }));
  }
}
