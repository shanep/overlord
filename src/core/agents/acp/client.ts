// Starts an ACP agent as a child process and connects to it over stdio with
// the ACP SDK, which handles the JSON-RPC both ways. The agent's requests and
// updates go to the handlers the runtime passes in.

import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { ReadableStream, WritableStream } from 'node:stream/web';

import {
  client,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

export interface AcpCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface AcpHandlers {
  readonly requestPermission: (
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  readonly sessionUpdate: (params: SessionNotification) => void;
}

export interface AcpExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the process never started, for example a missing binary. */
  readonly error: string | null;
}

export interface AcpProcess {
  readonly connection: ClientConnection;
  readonly exited: Promise<AcpExit>;
  /** Closes the agent's stdin, which tells it to exit. */
  readonly endInput: () => void;
  readonly kill: () => void;
  /** The end of what the agent wrote to stderr, for error messages. */
  readonly stderr: () => string;
}

const STDERR_KEEP = 4000;

/** StartOptions.extraArgs as CLI flags. */
export function flagArgs(extraArgs: Readonly<Record<string, string | null>>): string[] {
  return Object.entries(extraArgs).flatMap(([name, value]) =>
    value === null ? [`--${name}`] : [`--${name}`, value],
  );
}

/** Why the agent stopped, with the end of its stderr. */
export function exitError(command: string, exit: AcpExit, stderr: string): Error {
  const how =
    exit.error ??
    (exit.signal === null
      ? `exited with code ${String(exit.code)}`
      : `was killed by ${exit.signal}`);
  return new Error(stderr === '' ? `${command} ${how}` : `${command} ${how}: ${stderr}`);
}

function readableOf(stream: Readable): ReadableStream<Uint8Array> {
  let open = true;
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      stream.on('data', (chunk: Buffer) => {
        if (open) {
          controller.enqueue(new Uint8Array(chunk));
        }
      });
      stream.on('end', () => {
        if (open) {
          open = false;
          controller.close();
        }
      });
      stream.on('error', (error) => {
        if (open) {
          open = false;
          controller.error(error);
        }
      });
    },
    cancel(): void {
      // The SDK cancels the stream when the connection closes, before stdout ends.
      open = false;
    },
  });
}

function writableOf(stream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => {
          if (error === null || error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
    close(): void {
      stream.end();
    },
  });
}

export function startAcpProcess(command: AcpCommand, handlers: AcpHandlers): AcpProcess {
  const child = spawn(command.command, [...command.args], {
    cwd: command.cwd,
    env: { ...command.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP);
  });
  child.stdin.on('error', () => {
    // A write after the agent exits fails with EPIPE, which the exit already reports.
  });
  const exited = new Promise<AcpExit>((resolve) => {
    child.once('error', (error) => {
      resolve({ code: null, signal: null, error: error.message });
    });
    child.once('close', (code, signal) => {
      resolve({ code, signal, error: null });
    });
  });
  const connection = client({ name: 'overlord' })
    .onRequest('session/request_permission', async (context) =>
      handlers.requestPermission(context.params, context.signal),
    )
    .onNotification('session/update', (context) => {
      handlers.sessionUpdate(context.params);
    })
    .connect(ndJsonStream(writableOf(child.stdin), readableOf(child.stdout)));
  return {
    connection,
    exited,
    endInput: (): void => {
      child.stdin.end();
    },
    kill: (): void => {
      child.kill();
    },
    stderr: () => stderr.trim(),
  };
}
