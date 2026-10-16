// Entry point for the overlord-hook script that Claude Code runs for each hook
// event. All logic lives in client.ts; this only wires real stdin and stdout.
import os from 'node:os';
import process from 'node:process';

import { readStdin, resolveSocketPath, runHook } from './client.js';

async function main(): Promise<void> {
  const input = await readStdin(process.stdin);
  const socket = resolveSocketPath(process.env, os.homedir(), process.platform);
  const result = await runHook({ input, socketPath: socket });
  if (result.stdout !== '') {
    process.stdout.write(result.stdout);
  }
  process.exitCode = result.exitCode;
}

// The hook bundle is CommonJS, where esbuild cannot emit top-level await.
// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch(() => {
  // Never break Claude Code: any failure means "no opinion".
  process.exitCode = 0;
});
