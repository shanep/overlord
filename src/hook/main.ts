// Entry point for the overlord-hook script that an agent runs for each hook
// event. All logic lives in client.ts; this only wires real argv, stdin and
// stdout.
import os from 'node:os';
import process from 'node:process';

import { parseArgs, readStdin, resolveSocketPath, runHook } from './client.js';

async function main(): Promise<void> {
  const input = await readStdin(process.stdin);
  const socket = resolveSocketPath(process.env, os.homedir(), process.platform);
  const { agent, event } = parseArgs(process.argv.slice(2));
  const result = await runHook({ input, socketPath: socket, agent, event });
  if (result.stdout !== '') {
    process.stdout.write(result.stdout);
  }
  process.exitCode = result.exitCode;
}

// The hook bundle is CommonJS, where esbuild cannot emit top-level await.
// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch(() => {
  // Never break the agent: any failure means "no opinion".
  process.exitCode = 0;
});
