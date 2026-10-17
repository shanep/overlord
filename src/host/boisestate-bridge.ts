// Spawns and manages the boisestate.ai bridge sidecar for this window. The
// sidecar is started the first time a session runs on the boisestate
// backend, kept for the window's life, and killed on dispose. The real api key lives only in the child's environment,
// read from VS Code SecretStorage, and the loopback port is guarded by a random
// token. The token and port are saved and reused, so a chat tab that survives
// a window reload still reaches the new sidecar. Parsing comes from
// core/bridge, and so does the env each agent gets from the endpoint.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';

import type { BackendEndpoint } from '../core/bridge/backend.js';
import { BOISESTATE, parseReadyLine } from '../core/bridge/boisestate.js';

type SpawnFunction = typeof spawn;

/** What a sidecar reuses from the last one: its token, and its port or 0 for any. */
export interface SavedEndpoint {
  readonly port: number;
  readonly token: string;
}

export interface BoisestateBridgeOptions {
  /** Path to the bundled sidecar (dist/overlord-proxy.cjs). */
  readonly proxyPath: string;
  /** Reads the boisestate.ai api key from SecretStorage, or undefined if unset. */
  readonly getKey: () => Promise<string | undefined>;
  readonly onError?: (message: string) => void;
  /** The last sidecar's port and token, or null for a fresh start. */
  readonly loadEndpoint?: () => Promise<SavedEndpoint | null>;
  readonly saveEndpoint?: (endpoint: SavedEndpoint) => Promise<void>;
  readonly spawnFn?: SpawnFunction;
  readonly newToken?: () => string;
  readonly readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;

/** Raised when a session opts into the bridge but no api key has been set. */
class MissingBridgeKeyError extends Error {
  constructor() {
    super('No Boise State API key is set. Run "Overlord: Set Boise State API Key" first.');
    this.name = 'MissingBridgeKeyError';
  }
}

export class BoisestateBridge {
  private child: ChildProcess | null = null;
  private endpoint: BackendEndpoint | null = null;
  private starting: Promise<BackendEndpoint> | null = null;
  private readonly proxyPath: string;
  private readonly getKey: () => Promise<string | undefined>;
  private readonly onError: (message: string) => void;
  private readonly loadEndpoint: (() => Promise<SavedEndpoint | null>) | null;
  private readonly saveEndpoint: ((endpoint: SavedEndpoint) => Promise<void>) | null;
  private readonly spawnFn: SpawnFunction;
  private readonly newToken: () => string;
  private readonly readyTimeoutMs: number;

  constructor(options: BoisestateBridgeOptions) {
    this.proxyPath = options.proxyPath;
    this.getKey = options.getKey;
    this.onError =
      options.onError ??
      ((): void => {
        // No error sink configured.
      });
    // With nowhere to save it, every sidecar starts fresh.
    this.loadEndpoint = options.loadEndpoint ?? null;
    this.saveEndpoint = options.saveEndpoint ?? null;
    this.spawnFn = options.spawnFn ?? spawn;
    this.newToken = options.newToken ?? ((): string => randomUUID());
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  /** The running sidecar's endpoint, starting it first when it is not up. */
  async endpointFor(backend: string): Promise<BackendEndpoint> {
    if (backend !== BOISESTATE.id) {
      throw new Error(`This window has no endpoint for the ${backend} backend.`);
    }
    return this.ensure();
  }

  /** Start the sidecar now, when this window ran one before, so tabs from before a reload reconnect. */
  async warm(): Promise<void> {
    const saved = await this.saved();
    if (saved === null || saved.port === 0 || (await this.getKey()) === undefined) {
      return;
    }
    try {
      await this.ensure();
    } catch (error: unknown) {
      this.onError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Restart a running sidecar so it picks up a new api key. It waits for the
   * old one to exit so the new one gets the same port, and open tabs reconnect.
   */
  async restart(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    const exited =
      child.exitCode === null && child.signalCode === null
        ? once(child, 'exit')
        : Promise.resolve();
    this.dispose();
    await exited;
    try {
      await this.ensure();
    } catch (error: unknown) {
      this.onError(error instanceof Error ? error.message : String(error));
    }
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.endpoint = null;
    this.starting = null;
  }

  private async saved(): Promise<SavedEndpoint | null> {
    return this.loadEndpoint === null ? null : this.loadEndpoint();
  }

  private live(): BackendEndpoint | null {
    if (this.endpoint !== null && this.child !== null && this.child.exitCode === null) {
      return this.endpoint;
    }
    return null;
  }

  private async ensure(): Promise<BackendEndpoint> {
    const live = this.live();
    if (live !== null) {
      return live;
    }
    this.starting ??= this.spawnSidecar();
    return this.starting;
  }

  private async spawnSidecar(): Promise<BackendEndpoint> {
    const key = await this.getKey();
    if (key === undefined || key === '') {
      this.starting = null;
      throw new MissingBridgeKeyError();
    }
    const saved = await this.saved();
    const token = saved?.token ?? this.newToken();
    const child = this.spawnFn(process.execPath, [this.proxyPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BOISESTATE_API_KEY: key,
        BRIDGE_TOKEN: token,
        // The sidecar takes a free port when this one is taken.
        BRIDGE_PORT: String(saved?.port ?? 0),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const port = await this.awaitReady(child);
      const endpoint: BackendEndpoint = { baseUrl: `http://127.0.0.1:${String(port)}`, token };
      this.child = child;
      this.endpoint = endpoint;
      if (saved?.port !== port || saved.token !== token) {
        await this.saveEndpoint?.({ port, token });
      }
      child.once('exit', (code: number | null) => {
        // dispose() lets go of the child before it kills it, so only a crash gets here.
        if (this.child === child) {
          this.onError(`The bridge exited (code ${String(code)}). The next run starts a new one.`);
        }
        this.clear(child);
      });
      return endpoint;
    } catch (error) {
      child.kill();
      this.starting = null;
      throw error;
    }
  }

  private clear(child: ChildProcess): void {
    if (this.child === child) {
      this.child = null;
      this.endpoint = null;
      this.starting = null;
    }
  }

  private async awaitReady(child: ChildProcess): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let buffer = '';
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (act: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        act();
      };
      timer = setTimeout(() => {
        finish(() => {
          reject(
            new Error(`The bridge did not report ready within ${String(this.readyTimeoutMs)}ms.`),
          );
        });
      }, this.readyTimeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const port = parseReadyLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (port !== null) {
            finish(() => {
              resolve(port);
            });
            return;
          }
          newline = buffer.indexOf('\n');
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text !== '') {
          this.onError(text);
        }
      });
      child.once('error', (error: Error) => {
        finish(() => {
          reject(error);
        });
      });
      child.once('exit', (code: number | null) => {
        finish(() => {
          reject(new Error(`The bridge exited (code ${String(code)}) before reporting ready.`));
        });
      });
    });
  }
}
