// Calls one tool on an MCP server that speaks JSON-RPC over stdio: start it,
// initialize, call the tool, read the text it answers with, and stop it.
// Enough for a status probe; nothing here keeps a server running.

import { spawn } from 'node:child_process';

export interface StdioToolCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly tool: string;
  readonly timeoutMs: number;
}

/** Runs the call and resolves to the tool's text content. */
export type StdioToolCaller = (call: StdioToolCall) => Promise<string>;

const PROTOCOL_VERSION = '2025-06-18';
const INITIALIZE_ID = 1;
const CALL_ID = 2;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function request(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

function notification(method: string): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method })}\n`;
}

function parseLine(line: string): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function errorText(message: Readonly<Record<string, unknown>>): string | null {
  const error = message['error'];
  if (!isRecord(error)) {
    return null;
  }
  return typeof error['message'] === 'string' ? error['message'] : 'the server returned an error';
}

/** The text blocks of a tools/call result, joined. */
export function resultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result['content'])) {
    throw new Error('the tool answered without any content');
  }
  const blocks: readonly unknown[] = result['content'];
  const texts: string[] = [];
  for (const block of blocks) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      texts.push(block['text']);
    }
  }
  if (result['isError'] === true) {
    throw new Error(texts.join('\n') || 'the tool failed');
  }
  return texts.join('\n');
}

export const callStdioTool: StdioToolCaller = async (call) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(call.command, [...call.args], {
      cwd: call.cwd,
      env: { ...process.env, ...call.env },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let buffer = '';
    // Held in an object so finish, defined before the timer starts, can clear it.
    const run: { settled: boolean; timer: NodeJS.Timeout | undefined } = {
      settled: false,
      timer: undefined,
    };
    const finish = (outcome: () => void): void => {
      if (run.settled) {
        return;
      }
      run.settled = true;
      clearTimeout(run.timer);
      child.kill();
      outcome();
    };
    const fail = (message: string): void => {
      finish(() => {
        reject(new Error(message));
      });
    };
    run.timer = setTimeout(() => {
      fail(`${call.command} did not answer within ${String(call.timeoutMs / 1000)} seconds`);
    }, call.timeoutMs);

    const handle = (message: Readonly<Record<string, unknown>>): void => {
      const problem = errorText(message);
      if (problem !== null && (message['id'] === INITIALIZE_ID || message['id'] === CALL_ID)) {
        fail(problem);
        return;
      }
      if (message['id'] === INITIALIZE_ID) {
        child.stdin.write(notification('notifications/initialized'));
        child.stdin.write(request(CALL_ID, 'tools/call', { name: call.tool, arguments: {} }));
        return;
      }
      if (message['id'] === CALL_ID) {
        try {
          const text = resultText(message['result']);
          finish(() => {
            resolve(text);
          });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      }
    };

    child.on('error', (error) => {
      fail(error.message);
    });
    child.on('exit', (code) => {
      fail(`${call.command} exited ${String(code)} before it answered`);
    });
    child.stdin.on('error', () => {
      // A server that exits early closes stdin; the exit handler reports it.
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf('\n');
      while (end !== -1) {
        const message = parseLine(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message !== null) {
          handle(message);
        }
        end = buffer.indexOf('\n');
      }
    });
    child.stdin.write(
      request(INITIALIZE_ID, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'overlord', version: '1' },
      }),
    );
  });
