// A stand-in for `codex` in the MCP store tests, run as `node <this file>`.
// It appends its argv as one JSON line to the file FAKE_CODEX_ARGV names,
// prints FAKE_CODEX_STDERR to stderr when set, and exits with
// FAKE_CODEX_EXIT (0 by default). It never touches a real config.toml.

import { appendFileSync } from 'node:fs';

const log = process.env.FAKE_CODEX_ARGV;
if (log !== undefined && log !== '') {
  appendFileSync(log, `${JSON.stringify(process.argv.slice(2))}\n`);
}
const stderr = process.env.FAKE_CODEX_STDERR;
if (stderr !== undefined && stderr !== '') {
  process.stderr.write(stderr);
}
process.exitCode = Number(process.env.FAKE_CODEX_EXIT ?? '0');
