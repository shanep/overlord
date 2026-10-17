#!/usr/bin/env bash
# Tiny OTLP/HTTP JSON receiver on 127.0.0.1.
# The recording folder is the parent of this script's folder: record/ holds
# the scripts, repo/ the scratch git repo, out/ the raw output.
set -euo pipefail
REC_HOME="$(cd "$(dirname "$0")/.." && pwd)" exec node --input-type=module - "$@" <<'EOF'
// Tiny OTLP/HTTP receiver for the Codex fixtures. Listens on 127.0.0.1:PORT
// and appends {path, contentType, body} per request to out/otel.jsonl. JSON
// bodies are parsed; anything else is saved as base64.
import { appendFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const out = process.env.OTEL_OUT ?? path.resolve('out', 'otel.jsonl');
const port = Number(process.env.PORT ?? 4318);
mkdirSync(path.dirname(out), { recursive: true });

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] ?? '';
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = { base64: raw.toString('base64') };
      }
      appendFileSync(out, `${JSON.stringify({ path: req.url, method: req.method, contentType, body })}\n`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`otel receiver on 127.0.0.1:${port}`);
  });
EOF
