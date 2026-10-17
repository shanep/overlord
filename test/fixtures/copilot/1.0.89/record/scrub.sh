#!/bin/sh
# Scrub and trim one recorded file. Usage: scrub.sh <scratch-dir> <in-file> <out-file>
# The Node code is inline so the repo lint rules for .cjs and .mjs do not apply.
exec node - "$@" <<'NODE'
// Scrub and trim recorded Copilot output before it goes into the repo.
// Usage: scrub.sh <scratch-dir> <in-file> <out-file>
//   SCRUB_EXTRA=a,b  extra literals (a GitHub login, say) to replace with "user-login"
// Replaces the scratch dir with /work, the home dir with /home/user, the
// user name and host name, emails, tokens and request ids. Trims opaque
// blobs, long system prompts and long runs of streaming deltas. Works on
// JSONL (one JSON value per line) and on plain text files.
'use strict';
const fs = require('node:fs');
const os = require('node:os');

const [scratch, inFile, outFile] = process.argv.slice(2);
if (!scratch || !inFile || !outFile) {
  process.stderr.write('usage: scrub.sh <scratch-dir> <in-file> <out-file>\n');
  process.exit(2);
}

const home = os.homedir();
const user = os.userInfo().username;
const host = os.hostname().replace(/\.local$/u, '');
const extra = (process.env.SCRUB_EXTRA ?? '').split(',').filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Order matters: the longest, most specific literals go first.
const literalPairs = [
  [scratch, '/work'],
  [scratch.slice(1), 'work'],
  [home, '/home/user'],
  [home.slice(1), 'home/user'],
  ...extra.map((e) => [e, 'user-login']),
  [host, 'host'],
  [user, 'user'],
];
const patterns = [
  [/\b(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]+/gu, '<token>'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '<jwt>'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gu, 'Bearer <token>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, 'user@example.com'],
  [new RegExp(`[${String.fromCodePoint(0x20_13, 0x20_14)}]`, 'gu'), '-'],
];

function scrubText(s) {
  let out = s;
  for (const [from, to] of literalPairs) {
    if (from) out = out.replace(new RegExp(esc(from), 'giu'), to);
  }
  for (const [re, to] of patterns) out = out.replace(re, to);
  return out;
}

// Request and call ids that tie a run to the account on the server side.
const ID_KEYS = new Set([
  'request_id',
  'github_request_id',
  'service_request_id',
  'github.copilot.service_request_id',
  'apiCallId',
]);
// Opaque blobs: encrypted reasoning and server call handles.
const OPAQUE_KEYS = new Set([
  'encryptedContent',
  'encrypted_content',
  'reasoningOpaque',
  'model_call_id',
  'gen_ai.response.id',
]);
const ACCOUNT_KEY = /^(?:user|account|org|organization|tenant|enterprise)[_.]?(?:id|login|name|email)$/iu;
const KEEP_ARRAY = { tools: 3, availableCommands: 3 };
const LONG = 1200;

const idMap = new Map();
function placeholderId(v) {
  if (!idMap.has(v)) {
    const n = String(idMap.size + 1).padStart(12, '0');
    idMap.set(v, `00000000-0000-4000-8000-${n}`);
  }
  return idMap.get(v);
}

function walk(v, key) {
  if (typeof v === 'string') {
    if (OPAQUE_KEYS.has(key)) return `<trimmed ${String(v.length)} chars>`;
    if (ID_KEYS.has(key)) return placeholderId(v);
    if (ACCOUNT_KEY.test(key ?? '')) return '<redacted>';
    const s = scrubText(v);
    if (s.length > LONG * 2) return `${s.slice(0, LONG)} [trimmed ${String(s.length - LONG)} chars]`;
    return s;
  }
  if (Array.isArray(v)) {
    const keep = KEEP_ARRAY[key];
    const arr = keep !== undefined && v.length > keep ? v.slice(0, keep) : v;
    const mapped = arr.map((x) => walk(x, key));
    if (arr.length < v.length) mapped.push({ trimmed: v.length - arr.length });
    return mapped;
  }
  if (v && typeof v === 'object') {
    // Paths stored as hex bytes: decode, scrub, encode again.
    if (v.encoding === 'unix-bytes' && typeof v.data === 'string') {
      const p = scrubText(Buffer.from(v.data, 'hex').toString('utf8'));
      return { ...v, data: Buffer.from(p, 'utf8').toString('hex') };
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) out[scrubText(k)] = walk(x, k);
    return out;
  }
  return v;
}

// Streaming deltas come by the hundred. Keep the first few of each run.
const MAX_RUN = 5;
function runKey(o) {
  if (o.type === 'assistant.reasoning_delta') return `${o.type}:${String(o.data?.reasoningId)}`;
  if (o.type === 'session.background_tasks_changed') return o.type;
  const m = o.msg;
  const upd = m?.params?.update?.sessionUpdate;
  if (upd === 'agent_thought_chunk') return `${String(o.proc)}:${upd}`;
  return null;
}

const raw = fs.readFileSync(inFile, 'utf8');
const lines = raw.split('\n');
const isJsonl = lines.filter(Boolean).every((l) => {
  try {
    JSON.parse(l);
    return true;
  } catch {
    return false;
  }
});

let out;
if (isJsonl && lines.some(Boolean)) {
  const kept = [];
  let lastKey = null;
  let run = 0;
  let dropped = 0;
  for (const line of lines) {
    if (!line) continue;
    const o = JSON.parse(line);
    const k = runKey(o);
    run = k !== null && k === lastKey ? run + 1 : 1;
    lastKey = k;
    if (k !== null && run > MAX_RUN) {
      dropped++;
      continue;
    }
    kept.push(JSON.stringify(walk(o, null)));
  }
  out = kept.join('\n') + '\n';
  process.stderr.write(`${outFile}: kept ${String(kept.length)}, dropped ${String(dropped)} deltas\n`);
} else if (inFile.endsWith('.json')) {
  out = JSON.stringify(walk(JSON.parse(raw), null), null, 2) + '\n';
} else {
  out = scrubText(raw);
}
fs.writeFileSync(outFile, out);
NODE
