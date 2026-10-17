import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decode } from '../../otel/decode.js';
import { TELEMETRY_ENV_KEYS } from '../../otel/env.js';

import { claudeTelemetry } from './telemetry.js';

describe('claudeTelemetry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-claude-otel-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the env block to settings.json and removes it again', async () => {
    const dirs = { home: dir, configDir: dir };
    expect(await claudeTelemetry.enable(dirs, 4318)).toStrictEqual({ ok: true });
    const file = path.join(dir, 'settings.json');
    const on: unknown = JSON.parse(await readFile(file, 'utf8'));
    expect(on).toMatchObject({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      },
    });
    expect(await claudeTelemetry.disable(dirs)).toStrictEqual({ ok: true });
    const off = await readFile(file, 'utf8');
    for (const key of TELEMETRY_ENV_KEYS) {
      expect(off).not.toContain(key);
    }
  });

  it('stops at the first write that fails', async () => {
    await mkdir(path.join(dir, 'settings.json'));
    const result = await claudeTelemetry.enable({ home: dir, configDir: dir }, 4318);
    expect(result.ok).toBe(false);
  });

  it('decodes with the claude_code.* decoder', () => {
    expect(claudeTelemetry.decode).toBe(decode);
  });
});
