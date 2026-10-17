#!/usr/bin/env bash
# Drive codex app-server over stdio and log every JSON-RPC message.
# The recording folder is the parent of this script's folder: record/ holds
# the scripts, repo/ the scratch git repo, out/ the raw output.
set -euo pipefail
REC_HOME="$(cd "$(dirname "$0")/.." && pwd)" exec node --input-type=module - "$@" <<'EOF'
// Drive `codex app-server` over stdio and log every JSON-RPC message in both
// directions to out/app-server.jsonl as {dir, t, msg}. dir is "send" (client
// to server) or "recv" (server to client), t is milliseconds since start.
//
// Script: initialize, initialized, account/rateLimits/read, thread/start,
// turn 1 asks for a shell command under approvalPolicy "untrusted" and the
// client declines the approval, turn 2 asks for a long answer and the client
// sends turn/interrupt after the first agent message delta.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const here = process.env.REC_HOME;
const repo = path.join(here, 'repo');
const codex = process.env.CODEX_BIN ?? 'codex';
mkdirSync(path.join(here, 'out'), { recursive: true });
const log = createWriteStream(path.join(here, 'out', 'app-server.jsonl'));
const errLog = createWriteStream(path.join(here, 'out', 'app-server.stderr'));
const start = Date.now();

const child = spawn(codex, ['app-server', '-c', 'model_reasoning_effort=low'], {
  cwd: repo,
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.pipe(errLog);

let nextId = 1;
const pending = new Map();
const waiters = [];

function record(dir, msg) {
  log.write(`${JSON.stringify({ dir, t: Date.now() - start, msg })}\n`);
}

function send(msg) {
  record('send', msg);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(method, params) {
  send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
}

// Resolve when a server notification matches the predicate.
function waitFor(predicate, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting')), timeoutMs);
    waiters.push({
      predicate,
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
  });
}

let onDelta;

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    record('recv-raw', line);
    return;
  }
  record('recv', msg);
  if (msg.id !== undefined && msg.method === undefined) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.id !== undefined && msg.method !== undefined) {
    // A server request. Decline every approval, refuse anything else.
    if (/requestApproval$|Approval$/u.test(msg.method)) {
      const decision = msg.method.startsWith('item/') ? 'decline' : 'denied';
      send({ jsonrpc: '2.0', id: msg.id, result: { decision } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not handled by recorder' } });
    }
    return;
  }
  if (msg.method === 'item/agentMessage/delta' && onDelta) {
    const fn = onDelta;
    onDelta = undefined;
    fn(msg);
  }
  for (const w of [...waiters]) {
    if (w.predicate(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  }
});

const turnDone = () => waitFor((m) => m.method === 'turn/completed');

await request('initialize', {
  clientInfo: { name: 'overlord_fixture', title: 'Overlord fixture recorder', version: '0.0.0' },
});
notify('initialized');
await request('account/rateLimits/read', null);

const started = await request('thread/start', {
  cwd: repo,
  approvalPolicy: 'untrusted',
  sandbox: 'read-only',
});
const threadId = started.result?.thread?.id;

// Turn 1: a command that needs approval, declined.
const t1done = turnDone();
await request('turn/start', {
  threadId,
  effort: 'low',
  input: [
    {
      type: 'text',
      text: 'Run the shell command `touch approved.txt` once. If it is declined, reply with the word declined and stop.',
    },
  ],
});
await t1done;

// Turn 2: interrupted after the first streamed delta.
const t2done = turnDone();
const firstDelta = new Promise((resolve) => {
  onDelta = resolve;
});
const t2 = await request('turn/start', {
  threadId,
  effort: 'low',
  input: [{ type: 'text', text: 'Without running any commands, write a 400 word story about a lighthouse.' }],
});
const turnId = t2.result?.turn?.id;
await Promise.race([firstDelta, new Promise((r) => setTimeout(r, 20_000))]);
await request('turn/interrupt', { threadId, turnId });
await t2done.catch(() => undefined);

await request('account/rateLimits/read', null);
// Let trailing notifications land.
await new Promise((r) => setTimeout(r, 1500));
child.stdin.end();
child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
log.end();
console.log(`threadId=${threadId}`);
EOF
