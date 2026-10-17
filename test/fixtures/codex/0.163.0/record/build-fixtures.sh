#!/usr/bin/env bash
# Scrub the raw Codex recordings and write the fixture set.
# Usage: build-fixtures.sh <dest dir> <rollout file>...
# Reads out/ under the recording folder. Replaces the home path, the scratch
# folder, emails, account, user, org and installation ids, JWTs, Bearer values,
# sk- keys, the hostname and the time zone with placeholders. Cuts strings
# longer than 2000 characters, keeps every OTel log record and only a sample of
# trace spans and metrics.
set -euo pipefail
REC_HOME="$(cd "$(dirname "$0")/.." && pwd)" exec node --input-type=module - "$@" <<'EOF'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rec = process.env.REC_HOME;
const [dest, ...rollouts] = process.argv.slice(2);
const out = (p) => path.join(rec, 'out', p);
const home = os.homedir();
const host = os.hostname();
const hostShort = host.replace(/\.local$/u, '');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Values found by key anywhere in the raw data, replaced everywhere.
const secretKeys = new Set([
  'creator_user_id', 'creator_account_id', 'accountId', 'account_id', 'user.account_id',
  'installationId', 'installation_id', 'user.email', 'email', 'userId', 'user_id', 'orgId', 'org_id',
  'chatgpt_account_id', 'chatgptAccountId',
]);
const found = new Map();
const placeholder = (key, value) => {
  if (!found.has(value)) {
    const n = found.size + 1;
    found.set(value, key.includes('email') ? 'user@example.com'
      : key.includes('user') ? `user-${'X'.repeat(20)}${n}`
      : `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  }
};
const collect = (v, key = '') => {
  if (typeof v === 'string') {
    if (secretKeys.has(key) && v.length > 0) placeholder(key, v);
  } else if (Array.isArray(v)) {
    v.forEach((x) => collect(x, key));
  } else if (v && typeof v === 'object') {
    // OTLP attributes are {key, value: {stringValue}}.
    if (typeof v.key === 'string' && v.value && typeof v.value.stringValue === 'string') {
      collect(v.value.stringValue, v.key);
    }
    for (const [k, x] of Object.entries(v)) collect(x, k);
  }
};

const scrubText = (s) => {
  let t = s;
  for (const [value, ph] of found) t = t.split(value).join(ph);
  t = t.split(`${rec}/repo`).join('/work/repo');
  t = t.split(rec).join('/work');
  t = t.split(home).join('/home/user');
  t = t.split(host).join('host.example');
  t = t.split(hostShort).join('host');
  t = t.replace(/[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/gu, 'user@example.com');
  t = t.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '<jwt>');
  t = t.replace(/Bearer\s+[^\s"\\]+/gu, 'Bearer <redacted>');
  t = t.replace(/sk-[\w-]{16,}/gu, 'sk-<redacted>');
  t = t.replace(/\b(?:org|user)-[A-Za-z\d]{20,}\b/gu, (m) => `${m.slice(0, m.indexOf('-'))}-${'X'.repeat(20)}`);
  if (timeZone.includes('/') && timeZone !== 'America/Denver') t = t.split(timeZone).join('America/Denver');
  t = t.replaceAll('\u2014', '-').replaceAll('\u2013', '-');
  return t;
};

const cut = (v) => {
  if (typeof v === 'string') {
    return v.length > 2000 ? `${v.slice(0, 1000)}...[trimmed for fixture, ${v.length} chars]` : v;
  }
  if (Array.isArray(v)) return v.map(cut);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
  return v;
};

const readJsonl = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const writeJsonl = (file, records) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${records.map((r) => scrubText(JSON.stringify(cut(r)))).join('\n')}\n`);
};
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${scrubText(JSON.stringify(value, null, 2))}\n`);
};

// Load everything first so the id map covers every file.
const exec = Object.fromEntries(['plain', 'shell', 'edit', 'hooks-otel'].map((n) => [n, readJsonl(out(`exec-${n}.jsonl`))]));
const appServer = readJsonl(out('app-server.jsonl'));
const hooksList = readJsonl(out('hooks-list.jsonl'));
const otel = readJsonl(out('otel.jsonl'));
const rolloutData = rollouts.map((f) => [path.basename(f), readJsonl(f)]);
for (const v of [exec, appServer, hooksList, otel, rolloutData]) collect(v);

for (const [n, recs] of Object.entries(exec)) writeJsonl(path.join(dest, 'exec', `${n}.jsonl`), recs);
for (const [name, recs] of rolloutData) writeJsonl(path.join(dest, 'rollouts', name), recs);
writeJsonl(path.join(dest, 'app-server', 'session.jsonl'), appServer);
writeJsonl(path.join(dest, 'app-server', 'hooks-list.jsonl'), hooksList);

// OTel: logs in full, traces and metrics sampled.
const keepSpans = /^(?:thread\/start|session_init|codex\.turn_input|try_run_sampling_request|dispatch_tool_call_with_state|responses_websocket\.stream_request|run_hooks_and_record_inputs|session\.flush_rollout|code_mode\.broker\.invoke_tool)$/u;
const keepMetrics = /^codex\.(?:turn\.|conversation\.|thread\.started|tool\.|websocket\.request|process\.start|rollout\.size_bytes)/u;
const spanCounts = {};
const sampled = otel.map((r) => {
  const b = r.body;
  if (b.resourceSpans) {
    const seen = {};
    for (const rs of b.resourceSpans) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) spanCounts[s.name] = (spanCounts[s.name] ?? 0) + 1;
        ss.spans = (ss.spans ?? []).filter((s) => {
          if (!keepSpans.test(s.name)) return false;
          seen[s.name] = (seen[s.name] ?? 0) + 1;
          return seen[s.name] <= 2;
        });
      }
      rs.scopeSpans = (rs.scopeSpans ?? []).filter((ss) => ss.spans.length > 0);
    }
  }
  if (b.resourceMetrics) {
    for (const rm of b.resourceMetrics) {
      for (const sm of rm.scopeMetrics ?? []) sm.metrics = (sm.metrics ?? []).filter((m) => keepMetrics.test(m.name));
    }
  }
  return r;
});
writeJsonl(path.join(dest, 'otel', 'requests.jsonl'), sampled);
writeJson(path.join(dest, 'otel', 'trace-span-counts.json'),
  Object.fromEntries(Object.entries(spanCounts).sort((a, b) => b[1] - a[1])));
// Method names from `codex app-server generate-json-schema --out schema`.
const methods = {};
for (const f of ['ClientRequest', 'ClientNotification', 'ServerRequest', 'ServerNotification']) {
  const schema = JSON.parse(readFileSync(path.join(rec, 'schema', `${f}.json`), 'utf8'));
  const names = [];
  const walk = (o) => {
    if (o && typeof o === 'object') {
      if (o.properties?.method?.enum) names.push(...o.properties.method.enum);
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(schema.oneOf ?? schema.anyOf ?? schema);
  methods[f] = [...new Set(names)];
}
writeJson(path.join(dest, 'app-server', 'methods.json'), methods);
console.log(`scrubbed ${found.size} distinct id or email values`);
EOF
