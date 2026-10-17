import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { stableHookCommand } from '../hooks/stable-relay.js';

import { TRUST_STEP } from './setup-codex.js';
import { makeApp, makeEnv, shortSocketPath, waitFor } from './test-helpers/fixtures.js';

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

describe('Codex CLI hooks setup', () => {
  it('asks once Codex has its folder, tells the user to trust the hooks, and runs the hook server for them', async () => {
    const env = await makeEnv();
    const relay = path.join(env.host.extensionPath, 'dist', 'overlord-hook.cjs');
    await mkdir(path.dirname(relay), { recursive: true });
    await writeFile(relay, '// relay');
    const socket = shortSocketPath();
    const { app } = makeApp(env, { deps: { hookSocketPath: socket } });
    await app.start();
    const folder = path.join(env.home, '.codex');
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, 'hooks.json');
    env.host.confirmAnswers.push(false, true);
    await app.setup.installHooks();
    expect(env.host.questions.at(-1)).toStrictEqual({
      message:
        'Overlord will add its hooks to ~/.codex/hooks.json for Codex CLI. Your own hooks stay. Codex then asks you to trust them once in /hooks. Continue?',
      action: 'Install',
    });
    const written = await readFile(file, 'utf8');
    expect(written).toContain(
      JSON.stringify(`${stableHookCommand(env.home)} --agent codex`).slice(1, -1),
    );
    expect(written).not.toContain(env.host.extensionPath);
    expect(existsSync(path.join(env.home, '.overlord', 'bin', 'overlord-hook.cjs'))).toBe(true);
    expect(env.host.infos).toStrictEqual([`Hooks installed for Codex CLI. ${TRUST_STEP}`]);
    await waitFor(() => existsSync(socket));
    env.host.confirmAnswers.push(false, true);
    await app.setup.uninstallHooks();
    expect(env.host.questions.at(-1)?.message).toBe(
      'Remove the Overlord hooks from ~/.codex/hooks.json?',
    );
    await waitFor(() => !existsSync(socket));
    expect(env.host.infos.at(-1)).toBe('Codex CLI hooks removed.');
    await app.dispose();
  });
});

describe('Codex CLI telemetry setup', () => {
  it('adds the [otel] block after asking, starts the receiver for it, and takes it out', async () => {
    const env = await makeEnv();
    const port = await freePort();
    env.host.settings = { ...env.host.settings, telemetryPort: port };
    const folder = path.join(env.home, '.codex');
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, 'config.toml');
    await writeFile(file, 'model = "gpt-6-luna"\n');
    const { app } = makeApp(env);
    await app.start();
    env.host.confirmAnswers.push(false, true);
    await app.setup.enableTelemetry();
    expect(env.host.questions.at(-1)?.message).toBe(
      `Overlord will add an [otel] block to ~/.codex/config.toml so Codex CLI sessions you start yourself send their logs to 127.0.0.1:${String(port)}. Prompts stay off, and Overlord drops your email and account id from what it gets. The rest of the file stays as it is, with a copy in config.toml.bak. Continue?`,
    );
    expect(await readFile(file, 'utf8')).toContain(`127.0.0.1:${String(port)}/v1/logs`);
    expect(existsSync(env.paths.userSettings)).toBe(false);
    expect(app.telemetryPort).toBe(port);
    env.host.confirmAnswers.push(false, true);
    await app.setup.disableTelemetry();
    const after = await readFile(file, 'utf8');
    expect(after.trimEnd()).toBe('model = "gpt-6-luna"');
    expect(app.telemetryPort).toBeNull();
    expect(env.host.infos).toStrictEqual([
      'Telemetry is on for new Codex CLI sessions.',
      'Telemetry is off for new Codex CLI sessions.',
    ]);
    await app.dispose();
  });
});
