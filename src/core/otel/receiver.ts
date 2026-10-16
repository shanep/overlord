// A minimal OTLP/HTTP receiver for the JSON encoding, bound to loopback only.
// Claude Code posts to <endpoint>/v1/metrics, /v1/logs and /v1/traces.

import http from 'node:http';
import { gunzip } from 'node:zlib';

import { z } from 'zod';

import type { OtlpSignal } from './decode.js';

const addressSchema = z.object({ port: z.number() });

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

const SIGNALS: ReadonlyMap<string, OtlpSignal> = new Map([
  ['/v1/metrics', 'metrics'],
  ['/v1/logs', 'logs'],
  ['/v1/traces', 'traces'],
]);

export interface OtlpReceiverOptions {
  /** Zero or omitted picks a free port. */
  readonly port?: number;
  readonly host?: string;
  readonly maxBodyBytes?: number;
  readonly onExport: (signal: OtlpSignal, body: unknown) => void;
  /** Called when onExport throws, so a bad export never fails the response. */
  readonly onError?: (message: string) => void;
}

type BodyResult =
  { readonly ok: true; readonly data: Buffer } | { readonly ok: false; readonly status: number };

async function readBody(request: http.IncomingMessage, max: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= max) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      resolve(size > max ? { ok: false, status: 413 } : { ok: true, data: Buffer.concat(chunks) });
    });
    request.on('error', () => {
      resolve({ ok: false, status: 400 });
    });
  });
}

async function inflate(data: Buffer, max: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    gunzip(data, { maxOutputLength: max }, (error, result) => {
      if (error === null) {
        resolve({ ok: true, data: result });
        return;
      }
      resolve({
        ok: false,
        status: 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400,
      });
    });
  });
}

function parseJson(text: string): { readonly ok: boolean; readonly value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function send(
  response: http.ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function errorBody(message: string): Readonly<Record<string, unknown>> {
  return { code: 0, message };
}

export class OtlpReceiver {
  private readonly server: http.Server;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly maxBodyBytes: number;
  private readonly onExport: OtlpReceiverOptions['onExport'];
  private readonly onError: (message: string) => void;
  private boundPort: number | null = null;

  constructor(options: OtlpReceiverOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 0;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.onExport = options.onExport;
    this.onError =
      options.onError ??
      ((): void => {
        // No error sink configured.
      });
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  /** The bound port once started, else null. */
  get port(): number | null {
    return this.boundPort;
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.requestedPort, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    // A TCP listener always reports an AddressInfo.
    const { port } = addressSchema.parse(this.server.address());
    this.boundPort = port;
    return port;
  }

  async stop(): Promise<void> {
    if (!this.server.listening) {
      return;
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    this.boundPort = null;
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const signal = SIGNALS.get(new URL(String(request.url), 'http://localhost').pathname);
    if (signal === undefined) {
      request.resume();
      send(response, 404, errorBody('not found'));
      return;
    }
    if (request.method !== 'POST') {
      request.resume();
      send(response, 405, errorBody('method not allowed'), { allow: 'POST' });
      return;
    }
    const type = request.headers['content-type'] ?? '';
    if (!type.toLowerCase().startsWith('application/json')) {
      request.resume();
      send(response, 415, errorBody('only application/json is supported'));
      return;
    }
    const body = await this.body(request);
    if (!body.ok) {
      send(response, body.status, errorBody(body.status === 413 ? 'body too large' : 'bad body'));
      return;
    }
    const json = parseJson(body.data.toString('utf8'));
    if (!json.ok) {
      send(response, 400, errorBody('body is not JSON'));
      return;
    }
    try {
      this.onExport(signal, json.value);
    } catch (error) {
      this.onError(error instanceof Error ? error.message : String(error));
    }
    send(response, 200, {});
  }

  private async body(request: http.IncomingMessage): Promise<BodyResult> {
    const declared = Number(request.headers['content-length'] ?? '0');
    if (declared > this.maxBodyBytes) {
      request.resume();
      return { ok: false, status: 413 };
    }
    const raw = await readBody(request, this.maxBodyBytes);
    if (!raw.ok || request.headers['content-encoding'] !== 'gzip') {
      return raw;
    }
    return inflate(raw.data, this.maxBodyBytes);
  }
}
