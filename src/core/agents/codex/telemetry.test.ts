import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { serviceName } from '../../otel/by-service.js';
import type { OtlpSignal } from '../../otel/decode.js';
import type { TelemetryRecord } from '../../otel/records.js';
import type { AgentDirs } from '../types.js';

import { codexTelemetry, decodeCodex, OVERLORD_ENVIRONMENT } from './telemetry.js';

const FIXTURE = fileURLToPath(
  new URL('../../../../test/fixtures/codex/0.163.0/otel/requests.jsonl', import.meta.url),
);

const lineSchema = z.object({ path: z.string(), body: z.unknown() });

const SIGNALS: Readonly<Record<string, OtlpSignal>> = {
  '/v1/logs': 'logs',
  '/v1/metrics': 'metrics',
  '/v1/traces': 'traces',
};

async function recorded(): Promise<{ signal: OtlpSignal; body: unknown }[]> {
  const text = await readFile(FIXTURE, 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const { path: route, body } = lineSchema.parse(JSON.parse(line));
      const signal = SIGNALS[route];
      if (signal === undefined) {
        throw new Error(`unknown route ${route}`);
      }
      return { signal, body };
    });
}

async function decodedAll(): Promise<TelemetryRecord[]> {
  const exports = await recorded();
  return exports.flatMap(({ signal, body }) => decodeCodex(signal, body, 0) ?? []);
}

describe('decodeCodex', () => {
  it('reads the recorded 0.163.0 exports and never keeps the email or account id', async () => {
    const records = await decodedAll();
    expect(records.length).toBeGreaterThan(10);
    const text = JSON.stringify(records);
    expect(text).not.toContain('user.email');
    expect(text).not.toContain('user@example.com');
    expect(text).not.toContain('user.account_id');
    expect(text).not.toContain('cat notes.txt');
  });

  it('turns tool results and decisions into records of the thread', async () => {
    const records = await decodedAll();
    const result = records.find((record) => record.kind === 'tool_result');
    expect(result).toMatchObject({
      kind: 'tool_result',
      sessionId: '01a1480d-67aa-7441-952a-e378c41cbbb0',
      toolName: 'exec_command',
      toolUseId: 'exec-452a3922-b57f-4879-b9da-545063e9d7a2',
      success: true,
      durationMs: 57,
    });
    expect(records.some((record) => record.kind === 'tool_decision')).toBe(true);
    expect(records.filter((record) => record.kind === 'api_request')).toStrictEqual([]);
    expect(
      records.filter((record) => record.kind === 'event' && record.name === 'sse_event'),
    ).toHaveLength(3);
  });

  it('is null for a body that is not OTLP', () => {
    expect(decodeCodex('logs', 'nope', 0)).toBeNull();
  });

  it('is what the receiver picks for Codex exports', async () => {
    const [first] = await recorded();
    const name = first === undefined ? null : serviceName(first.signal, first.body);
    expect(name).toBe('codex_exec');
    expect(codexTelemetry.sends?.('codex_exec')).toBe(true);
    expect(codexTelemetry.sends?.('overlord')).toBe(true);
    expect(codexTelemetry.sends?.('claude-code')).toBe(false);
  });
});

describe('codexTelemetry settings', () => {
  let dir: string;
  let dirs: AgentDirs;
  const file = (): string => path.join(dir, 'config.toml');
  const userConfig = [
    '# my settings',
    'model = "gpt-6-luna"  # keep this',
    '',
    '[projects."/work/repo"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-codex-otel-'));
    dirs = { home: dir, configDir: dir };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds an [otel] block, keeps every other byte, and takes it out again', async () => {
    await writeFile(file(), userConfig);
    expect(await codexTelemetry.enabled?.(dirs)).toBe(false);
    expect(await codexTelemetry.enable(dirs, 4318)).toStrictEqual({ ok: true });
    const text = await readFile(file(), 'utf8');
    expect(text.startsWith(userConfig)).toBe(true);
    expect(text.slice(userConfig.length)).toContain('[otel]');
    expect(text).toContain('endpoint = "http://127.0.0.1:4318/v1/logs"');
    expect(text).toContain(`environment = "${OVERLORD_ENVIRONMENT}"`);
    expect(await readFile(`${file()}.bak`, 'utf8')).toBe(userConfig);
    expect(await codexTelemetry.enabled?.(dirs)).toBe(true);
    expect(await codexTelemetry.enable(dirs, 4319)).toStrictEqual({ ok: true });
    expect(await readFile(file(), 'utf8')).toContain('127.0.0.1:4319/v1/logs');
    expect(await codexTelemetry.disable(dirs)).toStrictEqual({ ok: true });
    const after = await readFile(file(), 'utf8');
    expect(after.trimEnd()).toBe(userConfig.trimEnd());
  });

  it("leaves the user's own [otel] settings alone", async () => {
    const own = `${userConfig}[otel]\nexporter = "none"\n`;
    await writeFile(file(), own);
    const result = await codexTelemetry.enable(dirs, 4318);
    expect(result.ok).toBe(false);
    expect(await readFile(file(), 'utf8')).toBe(own);
    expect(await codexTelemetry.disable(dirs)).toStrictEqual({ ok: true });
    expect(await readFile(file(), 'utf8')).toBe(own);
    expect(await codexTelemetry.launchConfig?.(dirs, 4318)).toStrictEqual([]);
    await writeFile(file(), `${userConfig}[otel]\nlog_user_prompt = true\n`);
    expect(await codexTelemetry.launchConfig?.(dirs, 4318)).toStrictEqual([]);
  });

  it('points one launch at the receiver with -c overrides and no file', async () => {
    expect(await codexTelemetry.launchConfig?.(dirs, 4318)).toStrictEqual([
      { key: ['otel', 'environment'], value: OVERLORD_ENVIRONMENT },
      { key: ['otel', 'log_user_prompt'], value: false },
      {
        key: ['otel', 'exporter'],
        raw: '{otlp-http={endpoint="http://127.0.0.1:4318/v1/logs",protocol="json"}}',
      },
    ]);
  });
});
