#!/bin/sh
# Drive copilot --acp over stdio and log both directions as JSONL.
# Usage: acp-driver.sh <repo-dir> <out.jsonl> [model]
# The Node code is inline so the repo lint rules for .cjs and .mjs do not apply.
exec node - "$@" <<'NODE'
// Drive `copilot --acp` over stdio and log both directions as JSONL.
// Usage: acp-driver.sh <repo-dir> <out.jsonl> [model]
// Steps: initialize, session/new, a prompt whose shell call we reject at
// session/request_permission, a prompt we cancel mid-turn, then a second
// process that runs session/load (and session/list when advertised).
'use strict';
const { spawn } = require('node:child_process');
const { appendFileSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const [repo, outFile, model = 'gpt-5-mini'] = process.argv.slice(2);
if (!repo || !outFile) {
  console.error('usage: acp-driver.sh <repo-dir> <out.jsonl> [model]');
  process.exit(2);
}
writeFileSync(outFile, '');
const log = (dir, proc, msg) =>
  appendFileSync(outFile, JSON.stringify({ dir, proc, t: new Date().toISOString(), msg }) + '\n');

function startAgent(proc) {
  const child = spawn('copilot', ['--acp', '--model', model, '--no-auto-update'], {
    cwd: repo,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  const send = (msg) => {
    log('send', proc, msg);
    child.stdin.write(JSON.stringify(msg) + '\n');
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('recv-raw', proc, line);
      return;
    }
    log('recv', proc, msg);
    if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    for (const fn of listeners) fn(msg);
  });
  child.stderr.on('data', (d) => log('stderr', proc, String(d).slice(0, 2000)));
  const request = (method, params, ms = 180000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), ms);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  return { child, request, notify, respond, respondError, on: (fn) => listeners.push(fn) };
}

const initParams = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'overlord-fixture-recorder', version: '0.0.0' },
};

async function main() {
  // Process A: new session, rejected permission, cancelled turn.
  const a = startAgent('A');
  let mode = 'reject';
  let cancelArmed = false;
  let sessionId;
  a.on((msg) => {
    if (msg.method === 'session/request_permission') {
      const opts = msg.params?.options ?? [];
      if (mode === 'reject') {
        const pick = opts.find((o) => o.kind === 'reject_once') ?? opts.find((o) => String(o.kind).startsWith('reject'));
        a.respond(msg.id, { outcome: { outcome: 'selected', optionId: pick?.optionId ?? 'reject_once' } });
      } else {
        a.respond(msg.id, { outcome: { outcome: 'cancelled' } });
      }
    } else if (msg.method === 'session/update' && cancelArmed) {
      const kind = msg.params?.update?.sessionUpdate;
      if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call') {
        cancelArmed = false;
        a.notify('session/cancel', { sessionId });
      }
    } else if (msg.method !== undefined && msg.id !== undefined) {
      a.respondError(msg.id, -32601, `client does not implement ${msg.method}`);
    }
  });

  const init = await a.request('initialize', initParams);
  const caps = init.result?.agentCapabilities ?? {};
  const created = await a.request('session/new', { cwd: repo, mcpServers: [] });
  sessionId = created.result?.sessionId;
  if (!sessionId) throw new Error('no sessionId from session/new');

  const modes = created.result?.modes;
  if (modes?.currentModeId) {
    await a.request('session/set_mode', { sessionId, modeId: modes.currentModeId });
  }

  mode = 'reject';
  await a.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Run the shell command `ls` and reply with how many files it listed.' }],
  });

  mode = 'cancel';
  cancelArmed = true;
  const cancelled = a.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Write a 300 word story about a lighthouse keeper.' }],
  });
  // Fallback: cancel after 4 s if no chunk has arrived yet.
  setTimeout(() => {
    if (cancelArmed) {
      cancelArmed = false;
      a.notify('session/cancel', { sessionId });
    }
  }, 4000);
  await cancelled;
  a.child.stdin.end();
  a.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));

  // Process B: load the session in a fresh process, list sessions if offered.
  const b = startAgent('B');
  b.on((msg) => {
    if (msg.method !== undefined && msg.id !== undefined) {
      b.respondError(msg.id, -32601, `client does not implement ${msg.method}`);
    }
  });
  const initB = await b.request('initialize', initParams);
  const capsB = initB.result?.agentCapabilities ?? caps;
  if (capsB.loadSession) {
    await b.request('session/load', { sessionId, cwd: repo, mcpServers: [] });
  }
  if (capsB.sessionCapabilities?.list) {
    await b.request('session/list', { cwd: repo });
  }
  if (capsB.sessionCapabilities?.resume) {
    await b.request('session/resume', { sessionId, cwd: repo, mcpServers: [] }).catch(() => {});
  }
  b.child.stdin.end();
  b.child.kill('SIGTERM');
  console.log(JSON.stringify({ sessionId, agentCapabilities: capsB }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
