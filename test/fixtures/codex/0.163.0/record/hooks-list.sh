#!/usr/bin/env bash
# Ask codex app-server for hooks/list (no model turn).
# The recording folder is the parent of this script's folder: record/ holds
# the scripts, repo/ the scratch git repo, out/ the raw output.
set -euo pipefail
REC_HOME="$(cd "$(dirname "$0")/.." && pwd)" exec node --input-type=module - "$@" <<'EOF'
// Ask `codex app-server` which hooks it sees and their trust status, with no
// model turn. Extra argv entries are passed to app-server (for -c overrides).
// Appends the exchange to out/hooks-list.jsonl as {dir, t, msg}.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const here = process.env.REC_HOME;
const repo = path.join(here, 'repo');
const out = path.join(here, 'out', 'hooks-list.jsonl');
const codex = process.env.CODEX_BIN ?? 'codex';
const start = Date.now();
const child = spawn(codex, ['app-server', ...process.argv.slice(2)], { cwd: repo, stdio: ['pipe', 'pipe', 'inherit'] });
const record = (dir, msg) => appendFileSync(out, `${JSON.stringify({ dir, t: Date.now() - start, msg })}\n`);
const send = (msg) => {
  record('send', msg);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
};
const pending = new Map();
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  record('recv', msg);
  if (msg.id !== undefined && msg.method === undefined) pending.get(msg.id)?.(msg);
});
let id = 0;
const request = (method, params) => {
  id += 1;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
};
await request('initialize', { clientInfo: { name: 'overlord_fixture', version: '0.0.0' } });
send({ jsonrpc: '2.0', method: 'initialized' });
const res = await request('hooks/list', { cwds: [repo] });
console.log(JSON.stringify(res.result, null, 1));
child.kill('SIGTERM');
EOF
