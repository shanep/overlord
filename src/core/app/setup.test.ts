import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TELEMETRY_ENV_KEYS } from '../otel/env.js';

import { hookCommand } from './setup.js';
import {
  makeApp,
  makeEnv,
  shortSocketPath,
  waitFor,
  writeJson,
  writeText,
  readJson,
} from './test-helpers/fixtures.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

describe('hookCommand', () => {
  it('runs the bundled hook script with node', () => {
    expect(hookCommand('/ext')).toBe(`node "${path.join('/ext', 'dist', 'overlord-hook.cjs')}"`);
  });
});

describe('hooks setup', () => {
  it('installs after asking, starts the hook server, and removes it again', async () => {
    const env = await makeEnv();
    const socket = shortSocketPath();
    const { app } = makeApp(env, { deps: { hookSocketPath: socket } });
    await app.start();
    await app.setup.installHooks();
    expect(existsSync(env.paths.userSettings)).toBe(false);
    expect(env.host.questions[0]).toStrictEqual({
      message:
        'Overlord will add its hook to every event in ~/.claude/settings.json. Your own hooks stay. Continue?',
      action: 'Install',
    });
    env.host.confirmAnswers.push(true, true);
    await app.setup.installHooks();
    await app.setup.installHooks();
    const settings = JSON.stringify(await readJson(env.paths.userSettings));
    expect(settings).toContain(JSON.stringify(hookCommand(env.host.extensionPath)).slice(1, -1));
    expect(existsSync(socket)).toBe(true);
    await expect(app.setup.status()).resolves.toMatchObject({ hooksInstalled: true });
    await app.setup.uninstallHooks();
    expect(existsSync(socket)).toBe(true);
    env.host.confirmAnswers.push(true, true);
    await app.setup.uninstallHooks();
    await app.setup.uninstallHooks();
    await waitFor(() => !existsSync(socket));
    expect(env.host.infos).toStrictEqual([
      'Hooks installed. New Claude Code sessions report to Overlord.',
      'Hooks were already installed.',
      'Hooks removed.',
      'No Overlord hooks were installed.',
    ]);
    expect(env.host.questions.map((question) => question.action)).toStrictEqual([
      'Install',
      'Install',
      'Install',
      'Remove',
      'Remove',
      'Remove',
    ]);
    expect(env.host.questions[3]?.message).toBe(
      'Remove the Overlord hooks from ~/.claude/settings.json?',
    );
  });
});

describe('telemetry setup', () => {
  it('writes the env block after asking and starts the receiver', async () => {
    const env = await makeEnv();
    const port = await freePort();
    env.host.settings = { ...env.host.settings, telemetryPort: port };
    const { app } = makeApp(env);
    await app.start();
    await app.setup.enableTelemetry();
    expect(existsSync(env.paths.userSettings)).toBe(false);
    expect(env.host.questions[0]).toStrictEqual({
      message: `Overlord will set the telemetry env vars in ~/.claude/settings.json so Claude Code sends metrics to 127.0.0.1:${String(port)}. Prompts and tool details stay off. Continue?`,
      action: 'Enable',
    });
    env.host.confirmAnswers.push(true);
    await app.setup.enableTelemetry();
    expect(await readJson(env.paths.userSettings)).toStrictEqual({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(port)}`,
        OTEL_METRIC_EXPORT_INTERVAL: '10000',
        OTEL_LOGS_EXPORT_INTERVAL: '2000',
      },
    });
    expect(app.telemetryPort).toBe(port);
    await expect(app.setup.status()).resolves.toMatchObject({ telemetryEnabled: true });
    await app.setup.disableTelemetry();
    expect(app.telemetryPort).toBe(port);
    env.host.confirmAnswers.push(true);
    await writeJson(env.paths.userSettings, {
      model: 'opus',
      env: { ...Object.fromEntries(TELEMETRY_ENV_KEYS.map((key) => [key, '1'])), KEEP: 'me' },
    });
    await app.setup.disableTelemetry();
    expect(await readJson(env.paths.userSettings)).toStrictEqual({
      model: 'opus',
      env: { KEEP: 'me' },
    });
    expect(app.telemetryPort).toBeNull();
    expect(env.host.infos).toStrictEqual([
      'Telemetry is on for new Claude Code sessions.',
      'Telemetry is off for new Claude Code sessions.',
    ]);
    expect(env.host.questions.map((question) => question.action)).toStrictEqual([
      'Enable',
      'Enable',
      'Disable',
      'Disable',
    ]);
    expect(env.host.questions[2]?.message).toBe(
      'Remove the telemetry env vars from ~/.claude/settings.json?',
    );
  });

  it('shows a failed write and stops at the first failure', async () => {
    const env = await makeEnv({ settings: { telemetryPort: 4318 } });
    await writeText(env.paths.userSettings, '{broken');
    const { app } = makeApp(env);
    env.host.confirmAnswers.push(true, true);
    await app.setup.enableTelemetry();
    await app.setup.disableTelemetry();
    expect(env.host.errors).toHaveLength(2);
    expect(env.host.errors[0]).toContain('is not valid JSON');
    expect(env.host.infos).toStrictEqual([]);
    expect(await readFile(env.paths.userSettings, 'utf8')).toBe('{broken');
  });

  it('reports no hooks for a settings file it cannot read', async () => {
    const env = await makeEnv();
    await writeJson(env.paths.userSettings, { hooks: 7 });
    const { app } = makeApp(env);
    const status = await app.setup.status();
    expect(status).toStrictEqual({
      hooksInstalled: false,
      telemetryEnabled: false,
      observerMode: false,
      errors: [],
    });
  });
});
