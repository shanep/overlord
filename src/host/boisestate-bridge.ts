// Spawns and manages the boisestate.ai bridge sidecar for this window. The
// sidecar is started the first time a session opts in (a profile whose
// ANTHROPIC_BASE_URL is the placeholder), kept for the window's life, and
// killed on dispose. The real api key lives only in the child's environment,
// read from VS Code SecretStorage; the loopback port is guarded by a per-run
// random token. Pure parsing and env rewriting come from core/bridge.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type { BridgeEndpoint } from '../core/bridge/boisestate.js';
import { applyBridge, needsBridge, parseReadyLine } from '../core/bridge/boisestate.js';

type SpawnFunction = typeof spawn;

export interface BoisestateBridgeOptions {
  /** Path to the bundled sidecar (dist/overlord-proxy.cjs). */
  readonly proxyPath: string;
  /** Reads the boisestate.ai api key from SecretStorage, or undefined if unset. */
  readonly getKey: () => Promise<string | undefined>;
  readonly onError?: (message: string) => void;
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
  private endpoint: BridgeEndpoint | null = null;
  private starting: Promise<BridgeEndpoint> | null = null;
  private readonly proxyPath: string;
  private readonly getKey: () => Promise<string | undefined>;
  private readonly onError: (message: string) => void;
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
    this.spawnFn = options.spawnFn ?? spawn;
    this.newToken = options.newToken ?? ((): string => randomUUID());
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  /** Rewrite a launch env, starting the sidecar when the env opts in. */
  async resolveEnv(env: Readonly<Record<string, string>>): Promise<Record<string, string>> {
    if (!needsBridge(env)) {
      return { ...env };
    }
    return applyBridge(env, await this.ensure());
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.endpoint = null;
    this.starting = null;
  }

  private live(): BridgeEndpoint | null {
    if (this.endpoint !== null && this.child !== null && this.child.exitCode === null) {
      return this.endpoint;
    }
    return null;
  }

  private async ensure(): Promise<BridgeEndpoint> {
    const live = this.live();
    if (live !== null) {
      return live;
    }
    this.starting ??= this.spawnSidecar();
    return this.starting;
  }

  private async spawnSidecar(): Promise<BridgeEndpoint> {
    const key = await this.getKey();
    if (key === undefined || key === '') {
      this.starting = null;
      throw new MissingBridgeKeyError();
    }
    const token = this.newToken();
    const child = this.spawnFn(process.execPath, [this.proxyPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BOISESTATE_API_KEY: key,
        BRIDGE_TOKEN: token,
        BRIDGE_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const port = await this.awaitReady(child);
      const endpoint: BridgeEndpoint = { baseUrl: `http://127.0.0.1:${String(port)}`, token };
      this.child = child;
      this.endpoint = endpoint;
      child.once('exit', () => {
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
