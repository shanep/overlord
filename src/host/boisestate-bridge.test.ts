import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { BoisestateBridge, type SavedEndpoint } from './boisestate-bridge.js';

interface Spawned {
  readonly key: string | undefined;
  readonly port: string | undefined;
  readonly child: { readonly signalCode: NodeJS.Signals | null };
}

/** A sidecar stand-in that reports ready on the port it was asked for, or 4000. */
function fakeSpawn(spawned: Spawned[]): typeof spawn {
  // The fake has only what the bridge uses (stdout, stderr, kill and exit), not
  // a whole ChildProcess, so it cannot satisfy spawn's type without a cast.
  // type-coverage:ignore-next-line
  return ((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    const stdout = new PassThrough();
    // eslint-disable-next-line unicorn/prefer-event-target -- the bridge listens with ChildProcess.once and .on
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(): boolean {
        setImmediate(() => {
          child.signalCode = 'SIGTERM';
          child.emit('exit', null, 'SIGTERM');
        });
        return true;
      },
    });
    const port = options.env['BRIDGE_PORT'];
    spawned.push({ key: options.env['BOISESTATE_API_KEY'], port, child });
    setImmediate(() => {
      stdout.write(`${JSON.stringify({ ready: true, port: Number(port) || 4000 })}\n`);
    });
    return child;
  }) as unknown as typeof spawn;
}

describe('BoisestateBridge.restart', () => {
  it('starts a new sidecar with the new key on the same port and token', async () => {
    const spawned: Spawned[] = [];
    let key = Promise.resolve('old-key');
    const saved: Promise<SavedEndpoint> = Promise.resolve({ port: 4100, token: 'token' });
    const bridge = new BoisestateBridge({
      proxyPath: 'proxy.cjs',
      getKey: async (): Promise<string> => key,
      loadEndpoint: async (): Promise<SavedEndpoint> => saved,
      spawnFn: fakeSpawn(spawned),
    });
    const before = await bridge.endpointFor('boisestate');

    key = Promise.resolve('new-key');
    await bridge.restart();
    const after = await bridge.endpointFor('boisestate');

    expect(spawned.map((entry) => entry.key)).toStrictEqual(['old-key', 'new-key']);
    expect(spawned[0]?.child.signalCode).toBe('SIGTERM');
    expect(spawned[1]?.port).toBe('4100');
    expect(after).toStrictEqual(before);
    bridge.dispose();
  });

  it('does nothing when no sidecar is running', async () => {
    const spawned: Spawned[] = [];
    const key = Promise.resolve('key');
    const bridge = new BoisestateBridge({
      proxyPath: 'proxy.cjs',
      getKey: async (): Promise<string> => key,
      spawnFn: fakeSpawn(spawned),
    });

    await bridge.restart();

    expect(spawned).toStrictEqual([]);
  });
});
