// Entry point for the bridge sidecar process. The extension spawns this with
// the api key in the environment, reads the chosen port from the first stdout
// line (a JSON object), and points sessions at http://127.0.0.1:<port> through
// ANTHROPIC_BASE_URL. Run it standalone with `npm run proxy` after a build.

import process from 'node:process';

import {
  countTokensHandler,
  makeAnthropicHandler,
  modelsHandler,
} from '../core/proxy/anthropic.js';
import { configFromEnv } from '../core/proxy/config.js';
import { makeOpenAiHandler } from '../core/proxy/openai.js';
import { BridgeServer } from '../core/proxy/server.js';
import type { RouteHandler } from '../core/proxy/server.js';
import type { UpstreamConfig } from '../core/proxy/upstream.js';

async function main(): Promise<void> {
  const result = configFromEnv(process.env);
  if (!result.ok) {
    process.stderr.write(`boisestate bridge: ${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  const config = result.config;
  const upstream: UpstreamConfig = {
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  };
  const routes: ReadonlyMap<string, RouteHandler> = new Map([
    ['/v1/chat/completions', makeOpenAiHandler(upstream)],
    ['/v1/messages', makeAnthropicHandler(upstream)],
    ['/v1/messages/count_tokens', countTokensHandler],
  ]);
  const getRoutes: ReadonlyMap<string, RouteHandler> = new Map([['/v1/models', modelsHandler]]);
  const server = new BridgeServer({
    host: config.host,
    port: config.port,
    bridgeToken: config.bridgeToken,
    routes,
    getRoutes,
    // The extension asks for the port it used last, so chat tabs outlive a reload.
    fallbackToAnyPort: true,
    onError: (message: string): void => {
      process.stderr.write(`boisestate bridge: ${message}\n`);
    },
  });
  const port = await server.start();
  process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`);

  const shutdown = (): void => {
    void server.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// The proxy bundle is CommonJS, where esbuild cannot emit top-level await.
// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((error: unknown) => {
  process.stderr.write(
    `boisestate bridge failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
