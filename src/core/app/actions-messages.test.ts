// Uses a temp home from makeEnv, so the settings writes never reach the real ~/.claude.
import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { messageActions } from './actions-messages.js';
import type { TestEnv } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, readJson, writeJson, writeText } from './test-helpers/fixtures.js';
import { cachedMessages } from './views/messages.js';

async function setup(): Promise<{ env: TestEnv; run: (value: string | null) => Promise<void> }> {
  const env = await makeEnv();
  const { app } = makeApp(env);
  const run = async (value: string | null): Promise<void> => {
    await messageActions.setInboundPolicy(
      { rt: app.runtime, params: {} },
      { type: 'setInboundPolicy', value },
    );
  };
  return { env, run };
}

describe('setInboundPolicy', () => {
  it('refuses a value that is not documented', async () => {
    const { env, run } = await setup();
    await run('sometimes');
    expect(env.host.errors).toStrictEqual([
      'sometimes is not a crossSessionInbound value. Use one of accept, hold, refuse.',
    ]);
    expect(env.host.questions).toStrictEqual([]);
  });

  it('writes nothing when the user says no', async () => {
    const { env, run } = await setup();
    await run('hold');
    expect(env.host.questions).toStrictEqual([
      {
        message:
          'Set crossSessionInbound to "hold" in your user settings? New sessions pick it up.',
        action: 'Save',
      },
    ]);
    await expect(readFile(env.paths.userSettings, 'utf8')).rejects.toThrow();
  });

  it('writes the user settings, then removes the key for null', async () => {
    const { env, run } = await setup();
    await writeJson(env.paths.userSettings, { theme: 'dark' });
    env.host.confirmAnswers.push(true, true);
    await run('refuse');
    expect(await readJson(env.paths.userSettings)).toStrictEqual({
      theme: 'dark',
      crossSessionInbound: 'refuse',
    });
    await run(null);
    expect(env.host.questions.at(-1)).toStrictEqual({
      message:
        'Remove crossSessionInbound from your user settings? Claude Code then decides per message.',
      action: 'Remove',
    });
    expect(await readJson(env.paths.userSettings)).toStrictEqual({ theme: 'dark' });
    expect(env.host.warnings).toStrictEqual([]);
    expect(env.host.errors).toStrictEqual([]);
  });

  it('refreshes the view state after saving', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    env.host.confirmAnswers.push(true);
    await messageActions.setInboundPolicy(
      { rt: app.runtime, params: {} },
      { type: 'setInboundPolicy', value: 'accept' },
    );
    expect(cachedMessages(app.runtime).inboundPolicy).toBe('accept');
  });

  it('warns when a managed setting still decides', async () => {
    const { env, run } = await setup();
    await writeJson(path.join(env.paths.managedDir, 'managed-settings.json'), {
      crossSessionInbound: 'refuse',
    });
    env.host.confirmAnswers.push(true);
    await run('accept');
    expect(env.host.warnings).toStrictEqual([
      'Saved, but another settings file still decides: crossSessionInbound is refuse.',
    ]);
  });

  it('says unset when the refresh could not read the settings', async () => {
    const { env, run } = await setup();
    const project = path.join(env.paths.projectsDir, '-w');
    await mkdir(path.join(env.root, 'a-folder'), { recursive: true });
    await mkdir(project, { recursive: true });
    await symlink(path.join(env.root, 'a-folder'), path.join(project, 'broken.jsonl'));
    env.host.confirmAnswers.push(true);
    await run('hold');
    expect(env.host.warnings).toStrictEqual([
      'Saved, but another settings file still decides: crossSessionInbound is unset.',
    ]);
  });

  it('shows the error when the settings file is not valid JSON', async () => {
    const { env, run } = await setup();
    await writeText(env.paths.userSettings, '{ broken');
    env.host.confirmAnswers.push(true);
    await run('hold');
    expect(env.host.errors).toHaveLength(1);
    expect(env.host.errors[0]).toContain('is not valid JSON');
    expect(await readFile(env.paths.userSettings, 'utf8')).toBe('{ broken');
  });
});
