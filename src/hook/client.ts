// The hook script's logic. It must never slow down or break the agent: when
// Overlord is not running it gives up within the connect budget, prints
// nothing and exits 0, and every failure path does the same. Its arguments
// say whose hook it is (--agent, Claude Code when left out, which is what
// every hook command installed before the flag runs) and, for agents whose
// stdin does not name the event, which event fired (--event).

import { randomUUID } from 'node:crypto';
import net from 'node:net';

import type { HookReplyMessage, HookRequestMessage } from '../core/hooks/protocol.js';
import {
  encodeMessage,
  isEmptyOutput,
  LineDecoder,
  parseReplyLine,
} from '../core/hooks/protocol.js';
import { SOCKET_ENV, socketPath } from '../core/hooks/socket-path.js';

export const CONNECT_TIMEOUT_MS = 200;
export const REPLY_TIMEOUT_MS = 2000;
/** A little past the server's ten minute hold, so the server's own answer always arrives first. */
export const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000 + 5000;

export interface RunHookOptions {
  /** The raw JSON the agent wrote to stdin. */
  readonly input: string;
  readonly socketPath: string;
  /** From --agent. Left out of the message when unset, which the server reads as Claude Code. */
  readonly agent?: string | null;
  /** From --event, for agents whose stdin does not name the event. */
  readonly event?: string | null;
  readonly connectTimeoutMs?: number;
  readonly replyTimeoutMs?: number;
  readonly permissionTimeoutMs?: number;
  readonly newId?: () => string;
  readonly maxLineBytes?: number;
}

export interface HookRunResult {
  /** What to print on stdout. Empty means print nothing. */
  readonly stdout: string;
  readonly exitCode: 0;
}

const SILENT: HookRunResult = { stdout: '', exitCode: 0 };

export interface HookInput {
  readonly name: string;
  readonly event: unknown;
}

/**
 * The stdin JSON and its event name, or null when it is not a hook payload.
 * The name comes from --event when the relay was given one, else from the
 * payload's hook_event_name, as Claude Code and Codex send it.
 */
export function parseInput(input: string, name: string | null = null): HookInput | null {
  let event: unknown;
  try {
    event = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return null;
  }
  if (name !== null && name !== '') {
    return { name, event };
  }
  if (!('hook_event_name' in event)) {
    return null;
  }
  return typeof event.hook_event_name === 'string' ? { name: event.hook_event_name, event } : null;
}

export interface RelayArgs {
  readonly agent: string | null;
  readonly event: string | null;
}

/** Reads --agent and --event, as "--agent copilot" or "--agent=copilot". Anything else is ignored. */
export function parseArgs(argv: readonly string[]): RelayArgs {
  const found = new Map<string, string>();
  for (const [index, argument] of argv.entries()) {
    for (const flag of ['--agent', '--event']) {
      if (argument === flag) {
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith('--')) {
          found.set(flag, value);
        }
      } else if (argument.startsWith(`${flag}=`)) {
        found.set(flag, argument.slice(flag.length + 1));
      }
    }
  }
  const valueOf = (flag: string): string | null => {
    const value = found.get(flag) ?? '';
    return value === '' ? null : value;
  };
  return { agent: valueOf('--agent'), event: valueOf('--event') };
}

/** Claude Code and Codex say PermissionRequest, Copilot says permissionRequest. */
function isPermissionRequest(name: string): boolean {
  return /^permissionRequest$/iu.test(name);
}

/** The socket to use: OVERLORD_HOOK_SOCKET, else the one in ~/.overlord. */
export function resolveSocketPath(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform,
): string {
  const override = env[SOCKET_ENV] ?? '';
  return override === '' ? socketPath({ home }, platform) : override;
}

export async function readStdin(
  stream: AsyncIterable<string | Buffer, unknown, unknown>,
): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
}

function requestFor(options: RunHookOptions, id: string, event: unknown): HookRequestMessage {
  const agent = options.agent ?? '';
  const name = options.event ?? '';
  return {
    id,
    event,
    ...(agent === '' ? {} : { agent }),
    ...(name === '' ? {} : { hook: name }),
  };
}

async function exchange(
  options: RunHookOptions,
  event: unknown,
  waitMs: number,
): Promise<HookRunResult> {
  const id = (options.newId ?? randomUUID)();
  return new Promise((resolve) => {
    const socket = net.createConnection(options.socketPath);
    const decoder = new LineDecoder(options.maxLineBytes);
    let timer: NodeJS.Timeout | undefined;
    const done = (result: HookRunResult = SILENT): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    timer = setTimeout(done, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

    socket.setEncoding('utf8');
    socket.once('error', () => {
      done();
    });
    socket.once('close', () => {
      done();
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      timer = setTimeout(done, waitMs);
      socket.write(encodeMessage(requestFor(options, id, event)));
    });
    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch {
        done();
        return;
      }
      const reply = lines
        .map((line) => parseReplyLine(line))
        .find((message): message is HookReplyMessage => message !== null && message.id === id);
      if (reply !== undefined) {
        done(
          isEmptyOutput(reply.output)
            ? SILENT
            : { stdout: JSON.stringify(reply.output), exitCode: 0 },
        );
      }
    });
  });
}

/** Forwards one hook event to Overlord and returns what to print. Never throws. */
export async function runHook(options: RunHookOptions): Promise<HookRunResult> {
  const input = parseInput(options.input, options.event ?? null);
  if (input === null) {
    return SILENT;
  }
  const waitMs = isPermissionRequest(input.name)
    ? (options.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS)
    : (options.replyTimeoutMs ?? REPLY_TIMEOUT_MS);
  return exchange(options, input.event, waitMs);
}
