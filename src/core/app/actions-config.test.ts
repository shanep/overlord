import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { isolatedExec } from '../sync/test-helpers/fixtures.js';

import { layerFile, settingsKeyPath } from './actions-config.js';
import {
  cloneConfigRepo,
  makeApp,
  makeEnv,
  NOW,
  readJson,
  sorted,
  writeJson,
  writeText,
} from './test-helpers/fixtures.js';

describe('settingsKeyPath', () => {
  it('maps catalog keys to where they live in settings', () => {
    expect(settingsKeyPath('model')).toBe('model');
    expect(settingsKeyPath('BASH_MAX_OUTPUT_LENGTH')).toBe('env.BASH_MAX_OUTPUT_LENGTH');
    expect(settingsKeyPath('--add-dir')).toBeNull();
    expect(settingsKeyPath('permissions.allow')).toBe('permissions.allow');
  });
});

describe('setKnob', () => {
  it('writes the user layer, refreshes knobs and clears context results', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    const clear = vi.spyOn(app.runtime.context, 'clear');
    await app.dispatch({ type: 'setKnob', key: 'model', value: 'opus', layer: 'user' }, {});
    await app.dispatch(
      { type: 'setKnob', key: 'BASH_MAX_OUTPUT_LENGTH', value: 5000, layer: 'user' },
      {},
    );
    expect(await readJson(env.paths.userSettings)).toStrictEqual({
      model: 'opus',
      env: { BASH_MAX_OUTPUT_LENGTH: 5000 },
    });
    const effective = app.runtime.caches.knobs.peek().effective;
    expect(effective.find((item) => item.key === 'model')?.value).toBe('opus');
    expect(clear).toHaveBeenCalledTimes(2);
    await app.dispatch({ type: 'setKnob', key: 'model', value: null, layer: 'user' }, {});
    expect(await readJson(env.paths.userSettings)).toStrictEqual({
      env: { BASH_MAX_OUTPUT_LENGTH: 5000 },
    });
    expect(env.host.infos).toStrictEqual([]);
    expect(env.host.errors).toStrictEqual([]);
  });

  it('writes project layers into the workspace', async () => {
    const env = await makeEnv({ workspace: true });
    const { app } = makeApp(env);
    const workspace = env.host.workspace ?? '';
    await app.dispatch({ type: 'setKnob', key: 'model', value: 'a', layer: 'project' }, {});
    await app.dispatch({ type: 'setKnob', key: 'model', value: 'b', layer: 'project-local' }, {});
    expect(await readJson(path.join(workspace, '.claude', 'settings.json'))).toStrictEqual({
      model: 'a',
    });
    expect(await readJson(path.join(workspace, '.claude', 'settings.local.json'))).toStrictEqual({
      model: 'b',
    });
    expect(layerFile(app.runtime, 'user')).toBe(env.paths.userSettings);
  });

  it('refuses flags, project layers without a folder, values that are not JSON and broken files', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'setKnob', key: '--add-dir', value: 'x', layer: 'user' }, {});
    await app.dispatch({ type: 'setKnob', key: 'model', value: 'x', layer: 'project' }, {});
    await app.dispatch(
      { type: 'setKnob', key: 'model', value: Number.POSITIVE_INFINITY, layer: 'user' },
      {},
    );
    await writeText(env.paths.userSettings, '{broken');
    await app.dispatch({ type: 'setKnob', key: 'model', value: 'x', layer: 'user' }, {});
    expect(env.host.infos).toStrictEqual([
      '--add-dir is a CLI flag. Add it to a launch profile instead.',
      'Open a folder to change project settings.',
    ]);
    expect(env.host.errors).toHaveLength(2);
    expect(env.host.errors[0]).toBe('The value for model is not plain JSON.');
    expect(env.host.errors[1]).toContain('is not valid JSON');
    expect(await readFile(env.paths.userSettings, 'utf8')).toBe('{broken');
    expect(layerFile(app.runtime, 'project-local')).toBeNull();
  });
});

describe('setKnob for keys outside the catalog', () => {
  it('writes and removes your own env var under env', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'setKnob', key: 'env.MY_VAR', value: 'x', layer: 'user' }, {});
    expect(await readJson(env.paths.userSettings)).toStrictEqual({ env: { MY_VAR: 'x' } });
    await app.dispatch({ type: 'setKnob', key: 'env.MY_VAR', value: null, layer: 'user' }, {});
    expect(await readJson(env.paths.userSettings)).toStrictEqual({ env: {} });
  });
});

describe('openKnobDocs', () => {
  it('opens the catalog docs page and nothing else', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'openKnobDocs', key: 'model', kind: 'setting' }, {});
    expect(env.host.external).toHaveLength(1);
    expect(env.host.external[0]).toMatch(/^https:\/\/code\.claude\.com\/docs\//u);
    await app.dispatch({ type: 'openKnobDocs', key: 'model', kind: 'flag' }, {});
    expect(env.host.external).toHaveLength(1);
    expect(env.host.infos).toStrictEqual(['No docs page is known for model.']);
  });
});

describe('importClaudeAi', () => {
  it('does nothing when cancelled', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'importClaudeAi' }, {});
    expect(env.host.filePicks).toStrictEqual([
      {
        title: 'Pick conversations.json or the unzipped claude.ai export folder',
        filters: { JSON: ['json'] },
      },
    ]);
    expect(env.host.infos).toStrictEqual([]);
    expect(env.host.errors).toStrictEqual([]);
  });

  it('shows why an import failed', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    env.host.fileAnswers.push(path.join(env.root, 'missing.json'));
    await app.dispatch({ type: 'importClaudeAi' }, {});
    expect(env.host.errors).toHaveLength(1);
    expect(env.host.errors[0]).toMatch(/^Import failed: /u);
  });

  it('stores the chats and shows them in the sessions view', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    const file = await writeJson(path.join(env.root, 'export', 'conversations.json'), [
      { uuid: 'c1', name: 'First', updated_at: '2026-10-01T00:00:00Z', chat_messages: [] },
      { uuid: 'c2', name: 'Second', chat_messages: [] },
    ]);
    env.host.fileAnswers.push(file);
    await app.dispatch({ type: 'importClaudeAi' }, {});
    expect(env.host.infos).toStrictEqual(['Imported 2 chats.']);
    const stored = await readJson(path.join(env.storageDir, 'claude-ai.json'));
    expect(stored).toMatchObject({ version: 1, importedAt: NOW });
    const state = app.stateFor('sessions', {});
    expect(state).toMatchObject({ state: { claudeAiImportedAt: NOW } });
    if (state.view !== 'sessions') {
      throw new Error('wrong view');
    }
    expect(sorted(state.state.sessions.map((row) => row.title))).toStrictEqual(['First', 'Second']);
  });

  it('imports an export with no chats', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    env.host.fileAnswers.push(await writeJson(path.join(env.root, 'conversations.json'), []));
    await app.dispatch({ type: 'importClaudeAi' }, {});
    expect(env.host.infos).toStrictEqual(['Imported 0 chats.']);
  });
});

describe('adoptConfig', () => {
  it('moves a local agent into the config repo and links it back', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    const agentFile = await writeText(
      path.join(env.paths.userAgentsDir, 'helper.md'),
      '# helper\n',
    );
    const { app } = makeApp(env, { deps: { exec } });
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'adoptConfig', itemId: 'user:agent:helper' }, {});
    expect(env.host.errors).toStrictEqual([]);
    expect(env.host.questions).toStrictEqual([
      { message: 'Move helper into the config repo and link it back?', action: 'Adopt' },
    ]);
    const linked = await lstat(agentFile);
    expect(linked.isSymbolicLink()).toBe(true);
    expect(await readlink(agentFile)).toBe(path.join(repo, 'agents', 'helper.md'));
    expect(await readFile(path.join(repo, 'agents', 'helper.md'), 'utf8')).toBe('# helper\n');
    const manifest = await readJson(path.join(repo, 'overlord.json'));
    expect(manifest).toMatchObject({
      items: [
        {
          id: 'agent:helper',
          kind: 'agent',
          source: 'agents/helper.md',
          target: '~/.claude/agents/helper.md',
          mode: 'link',
        },
      ],
    });
    expect(env.host.infos).toHaveLength(1);
    expect(env.host.infos[0]).toMatch(/^Applied \d+ changes\. Backup in ~\/\.claude\/backups\//u);
    const item = app.runtime.caches.config
      .peek()
      .items.find((entry) => entry.id === 'user:agent:helper');
    expect(item?.status).toBe('modified');
  });

  it('asks first and changes nothing on no', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    await cloneConfigRepo(env, exec);
    const agentFile = await writeText(
      path.join(env.paths.userAgentsDir, 'helper.md'),
      '# helper\n',
    );
    const { app } = makeApp(env, { deps: { exec } });
    await app.dispatch({ type: 'adoptConfig', itemId: 'user:agent:helper' }, {});
    expect(env.host.questions).toHaveLength(1);
    const untouched = await lstat(agentFile);
    expect(untouched.isSymbolicLink()).toBe(false);
  });

  it('refuses items that are not local-only, unknown kinds and missing repos', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    await writeText(path.join(env.paths.userAgentsDir, 'helper.md'), '# helper\n');
    await writeJson(env.paths.userSettings, {});
    const { app } = makeApp(env, { deps: { exec } });
    await app.dispatch({ type: 'adoptConfig', itemId: 'built-in:agent:Explore' }, {});
    await app.dispatch({ type: 'adoptConfig', itemId: 'nope' }, {});
    await app.dispatch({ type: 'adoptConfig', itemId: 'user:agent:helper' }, {});
    await cloneConfigRepo(env, exec);
    await app.dispatch({ type: 'adoptConfig', itemId: 'user:settings:settings.json' }, {});
    expect(env.host.infos).toStrictEqual([
      'Only local-only items can be adopted.',
      'Only local-only items can be adopted.',
      'Connect a config repo first.',
      'Overlord cannot adopt settings.json yet.',
    ]);
    expect(env.host.questions).toStrictEqual([]);
  });

  it('refuses when the repo already holds different content', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    await cloneConfigRepo(env, exec, {
      'overlord.json': '{"version":1}\n',
      'agents/helper.md': '# other\n',
    });
    await writeText(path.join(env.paths.userAgentsDir, 'helper.md'), '# helper\n');
    const { app } = makeApp(env, { deps: { exec } });
    await app.dispatch({ type: 'adoptConfig', itemId: 'user:agent:helper' }, {});
    expect(env.host.errors).toStrictEqual([
      'agents/helper.md already exists in the config repo with different content.',
    ]);
    expect(env.host.questions).toStrictEqual([]);
  });
});
