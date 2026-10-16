import http from 'node:http';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import type { OtlpSignal } from './decode.js';
import type { OtlpReceiverOptions } from './receiver.js';
import { DEFAULT_MAX_BODY_BYTES, OtlpReceiver } from './receiver.js';

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: http.IncomingHttpHeaders;
}

interface RequestSpec {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | string;
  /** Send the body in pieces without a content-length. */
  readonly chunks?: readonly string[];
}

async function request(port: number, spec: RequestSpec): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        method: spec.method ?? 'POST',
        path: spec.path,
        headers: spec.headers,
      },
      (incoming) => {
        const parts: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => parts.push(chunk));
        incoming.on('end', () => {
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(parts).toString('utf8'),
            headers: incoming.headers,
          });
        });
      },
    );
    outgoing.on('error', reject);
    for (const chunk of spec.chunks ?? []) {
      outgoing.write(chunk);
    }
    outgoing.end(spec.body);
  });
}

const json = { 'content-type': 'application/json' };

describe('OtlpReceiver', () => {
  const receivers: OtlpReceiver[] = [];
  const exports: { signal: OtlpSignal; body: unknown }[] = [];

  async function start(options: Partial<OtlpReceiverOptions> = {}): Promise<number> {
    const receiver = new OtlpReceiver({
      onExport: (signal, body): void => {
        exports.push({ signal, body });
      },
      ...options,
    });
    receivers.push(receiver);
    return receiver.start();
  }

  afterEach(async () => {
    await Promise.all(receivers.map(async (receiver) => receiver.stop()));
    receivers.length = 0;
    exports.length = 0;
  });

  it('caps bodies at 8 MB by default', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
  });

  it('binds to loopback on a free port and reports it', async () => {
    const receiver = new OtlpReceiver({
      onExport: (): void => {
        // Not used.
      },
    });
    receivers.push(receiver);
    expect(receiver.port).toBeNull();
    const port = await receiver.start();
    expect(port).toBeGreaterThan(0);
    expect(receiver.port).toBe(port);
    await receiver.stop();
    expect(receiver.port).toBeNull();
    await receiver.stop();
  });

  it('accepts JSON on each signal path', async () => {
    const port = await start();
    const cases: readonly (readonly [string, OtlpSignal])[] = [
      ['/v1/metrics', 'metrics'],
      ['/v1/logs', 'logs'],
      ['/v1/traces?x=1', 'traces'],
    ];
    for (const [path, signal] of cases) {
      const reply = await request(port, { path, headers: json, body: `{"from":"${signal}"}` });
      expect(reply.status).toBe(200);
      expect(reply.body).toBe('{}');
      expect(reply.headers['content-type']).toBe('application/json');
    }
    expect(exports).toStrictEqual([
      { signal: 'metrics', body: { from: 'metrics' } },
      { signal: 'logs', body: { from: 'logs' } },
      { signal: 'traces', body: { from: 'traces' } },
    ]);
  });

  it('accepts a charset on the content type', async () => {
    const port = await start();
    const reply = await request(port, {
      path: '/v1/logs',
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
      body: '[]',
    });
    expect(reply.status).toBe(200);
    expect(exports).toStrictEqual([{ signal: 'logs', body: [] }]);
  });

  it('answers 404 for other paths and 405 for other methods', async () => {
    const port = await start();
    const missing = await request(port, { path: '/v1/profiles', headers: json, body: '{}' });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toStrictEqual({ code: 0, message: 'not found' });
    const get = await request(port, { method: 'GET', path: '/v1/metrics' });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect(JSON.parse(get.body)).toStrictEqual({ code: 0, message: 'method not allowed' });
    expect(exports).toStrictEqual([]);
  });

  it('answers 415 for anything but JSON', async () => {
    const port = await start();
    const protobuf = await request(port, {
      path: '/v1/metrics',
      headers: { 'content-type': 'application/x-protobuf' },
      body: 'x',
    });
    expect(protobuf.status).toBe(415);
    expect(JSON.parse(protobuf.body)).toStrictEqual({
      code: 0,
      message: 'only application/json is supported',
    });
    const none = await request(port, { path: '/v1/metrics', body: '{}' });
    expect(none.status).toBe(415);
    expect(exports).toStrictEqual([]);
  });

  it('answers 400 for a body that is not JSON', async () => {
    const port = await start();
    const reply = await request(port, { path: '/v1/logs', headers: json, body: '{nope' });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toStrictEqual({ code: 0, message: 'body is not JSON' });
    expect(exports).toStrictEqual([]);
  });

  it('answers 413 when the declared length is over the cap', async () => {
    const port = await start({ maxBodyBytes: 10 });
    const reply = await request(port, {
      path: '/v1/logs',
      headers: json,
      body: '{"a":"12345678"}',
    });
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toStrictEqual({ code: 0, message: 'body too large' });
    expect(exports).toStrictEqual([]);
  });

  it('accepts a body exactly at the cap', async () => {
    const port = await start({ maxBodyBytes: 9 });
    const reply = await request(port, { path: '/v1/logs', headers: json, body: '{"a":"1"}' });
    expect(reply.status).toBe(200);
  });

  it('answers 413 when a chunked body grows past the cap', async () => {
    const port = await start({ maxBodyBytes: 10 });
    const reply = await request(port, {
      path: '/v1/logs',
      headers: { ...json, 'transfer-encoding': 'chunked' },
      chunks: ['{"a":', '"123456', '78"}'],
    });
    expect(reply.status).toBe(413);
    expect(exports).toStrictEqual([]);
  });

  it('reads a chunked body under the cap', async () => {
    const port = await start({ maxBodyBytes: 100 });
    const reply = await request(port, {
      path: '/v1/logs',
      headers: { ...json, 'transfer-encoding': 'chunked' },
      chunks: ['{"a":', '1}'],
    });
    expect(reply.status).toBe(200);
    expect(exports).toStrictEqual([{ signal: 'logs', body: { a: 1 } }]);
  });

  it('inflates gzip bodies', async () => {
    const port = await start();
    const reply = await request(port, {
      path: '/v1/metrics',
      headers: { ...json, 'content-encoding': 'gzip' },
      body: gzipSync('{"zipped":true}'),
    });
    expect(reply.status).toBe(200);
    expect(exports).toStrictEqual([{ signal: 'metrics', body: { zipped: true } }]);
  });

  it('answers 400 for broken gzip and 413 when it inflates past the cap', async () => {
    const port = await start({ maxBodyBytes: 64 });
    const broken = await request(port, {
      path: '/v1/metrics',
      headers: { ...json, 'content-encoding': 'gzip' },
      body: 'not gzip',
    });
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body)).toStrictEqual({ code: 0, message: 'bad body' });
    const bomb = await request(port, {
      path: '/v1/metrics',
      headers: { ...json, 'content-encoding': 'gzip' },
      body: gzipSync(`{"a":"${'x'.repeat(1000)}"}`),
    });
    expect(bomb.status).toBe(413);
    expect(exports).toStrictEqual([]);
  });

  it('still answers 200 when the export handler throws', async () => {
    const errors: string[] = [];
    const port = await start({
      onExport: () => {
        throw new Error('decoder broke');
      },
      onError: (message) => errors.push(message),
    });
    const reply = await request(port, { path: '/v1/logs', headers: json, body: '{}' });
    expect(reply.status).toBe(200);
    expect(errors).toStrictEqual(['decoder broke']);
  });

  it('reports non-Error throws and tolerates a missing error sink', async () => {
    const errors: string[] = [];
    const port = await start({
      onExport: () => {
        // Covers a handler that throws something other than an Error.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain';
      },
      onError: (message) => errors.push(message),
    });
    await request(port, { path: '/v1/logs', headers: json, body: '{}' });
    expect(errors).toStrictEqual(['plain']);
    const quiet = await start({
      onExport: () => {
        throw new Error('ignored');
      },
    });
    const quietReply = await request(quiet, { path: '/v1/logs', headers: json, body: '{}' });
    expect(quietReply.status).toBe(200);
  });

  it('survives a client that hangs up mid-body', async () => {
    const port = await start();
    await new Promise<void>((resolve) => {
      const outgoing = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/logs',
        headers: { ...json, 'content-length': '100' },
      });
      outgoing.on('error', () => {
        resolve();
      });
      outgoing.write('{"partial":', () => {
        setTimeout(() => {
          outgoing.destroy();
        }, 20);
      });
    });
    const reply = await request(port, { path: '/v1/logs', headers: json, body: '{"after":1}' });
    expect(reply.status).toBe(200);
    expect(exports).toStrictEqual([{ signal: 'logs', body: { after: 1 } }]);
  });

  it('fails to start on a port in use', async () => {
    const port = await start();
    const second = new OtlpReceiver({
      port,
      onExport: (): void => {
        // Not used.
      },
    });
    await expect(second.start()).rejects.toThrow(/EADDRINUSE/u);
    expect(second.port).toBeNull();
  });
});
