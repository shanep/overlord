// Lists flaky tests: ones that failed and also passed on the same code, in
// any worktree on this machine, from the log the flake reporter keeps.
//
//   npm run flakes            the flaky tests, most often first
//   npm run flakes -- --json  the same as JSON
import process from 'node:process';

import { defaultLogPath, findFlakes, readLog } from './flake-log.mjs';

const file = process.env.OVERLORD_TEST_LOG || defaultLogPath();
const flakes = findFlakes(readLog(file));
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(flakes, null, 2)}\n`);
} else if (flakes.length === 0) {
  process.stdout.write(`No flaky tests in ${file}.\n`);
} else {
  for (const flake of flakes) {
    const when = new Date(flake.lastAt).toISOString().slice(0, 16).replace('T', ' ');
    process.stdout.write(
      `${flake.id}\n  failed ${String(flake.failures)} times on code it also passed on, in ${String(flake.worktrees)} worktrees, last ${when}\n  ${flake.lastMessage.split('\n', 1)[0]}\n`,
    );
  }
}
