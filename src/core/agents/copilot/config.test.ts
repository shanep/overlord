import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COPILOT } from '../../../shared/agents.js';
import type { LaunchProfile } from '../../../shared/model.js';
import { catalogEnvKeys } from '../../knobs/catalog.js';
import { computeEffective } from '../../knobs/effective.js';
import { loadLayers } from '../../knobs/layers.js';
import { writeSetting } from '../../knobs/write.js';

import { copilotKnobs, copilotLaunchOverrides } from './config.js';

const HEADER = '// User settings belong in settings.json.\n';

function profile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: 'p',
    name: 'p',
    agent: COPILOT,
    model: null,
    effort: null,
    permissionMode: null,
    env: {},
    extraArgs: [],
    ...overrides,
  };
}

describe('copilotKnobs', () => {
  let dir: string;
  let home: string;
  let repo: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-copilot-knobs-'));
    home = path.join(dir, 'copilot-home');
    repo = path.join(dir, 'repo');
    await mkdir(home, { recursive: true });
    await mkdir(path.join(repo, '.github', 'copilot'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function load(
    env: Readonly<Record<string, string>>,
  ): Promise<ReturnType<typeof computeEffective>> {
    const layers = await loadLayers({
      knobs: copilotKnobs,
      paths: { home: dir, managedDir: dir, userSettings: path.join(dir, 'unused.json') },
      projectDir: repo,
      env: { COPILOT_HOME: home, ...env },
      envKeys: catalogEnvKeys(copilotKnobs.catalog()),
    });
    expect(layers.map((layer) => layer.error)).toStrictEqual([null, null, null, null]);
    return computeEffective(layers, copilotKnobs);
  }

  it('reads user, repository and local JSONC files in Copilot order, with env vars on top', async () => {
    await writeFile(
      path.join(home, 'settings.json'),
      `${HEADER}{\n  "model": "gpt-5.4", // mine\n  "theme": "dim",\n  "deniedUrls": ["a.dev"],\n}\n`,
    );
    await writeFile(
      path.join(repo, '.github', 'copilot', 'settings.json'),
      '{ "model": "claude-sonnet-5", "deniedUrls": ["b.dev"], "companyAnnouncements": ["hi"] }',
    );
    await writeFile(
      path.join(repo, '.github', 'copilot', 'settings.local.json'),
      '/* personal */ { "model": "auto" }',
    );
    const effective = await load({ COPILOT_MODEL: 'gpt-5-mini', COPILOT_ANYTHING: 'x' });
    const value = (key: string): unknown => effective.find((item) => item.key === key)?.value;
    const layer = (key: string): unknown => effective.find((item) => item.key === key)?.layer;
    expect([value('model'), layer('model')]).toStrictEqual(['auto', 'project-local']);
    expect([value('theme'), layer('theme')]).toStrictEqual(['dim', 'user']);
    // deniedUrls is a union, so every layer's entries count.
    expect(value('deniedUrls')).toStrictEqual(['b.dev', 'a.dev']);
    expect(value('env.COPILOT_MODEL')).toBe('gpt-5-mini');
    expect(value('env.COPILOT_ANYTHING')).toBe('x');
  });

  it('lets the repository replace companyAnnouncements instead of adding to it', async () => {
    await writeFile(path.join(home, 'settings.json'), '{ "companyAnnouncements": ["mine"] }');
    await writeFile(
      path.join(repo, '.github', 'copilot', 'settings.json'),
      '{ "companyAnnouncements": ["repo"] }',
    );
    const effective = await load({});
    expect(effective.find((item) => item.key === 'companyAnnouncements')?.value).toStrictEqual([
      'repo',
    ]);
  });

  it('saves a knob to the user file and keeps the comments Copilot wrote at the top', async () => {
    const file = path.join(home, 'settings.json');
    await writeFile(file, `${HEADER}{\n  "theme": "dim"\n}\n`);
    const user = copilotKnobs.layers.find((layer) => layer.layer === 'user');
    const target =
      user?.kind === 'file'
        ? user.file({
            paths: { home: dir, managedDir: dir, userSettings: '' },
            projectDir: null,
            env: { COPILOT_HOME: home },
          })
        : null;
    expect(target).toBe(file);
    await writeSetting({ file, keyPath: 'model', value: 'auto', format: 'jsonc' });
    expect(await readFile(file, 'utf8')).toBe(
      `${HEADER}{\n  "theme": "dim",\n  "model": "auto"\n}\n`,
    );
  });

  it('has a catalog of Copilot settings, env vars and flags', () => {
    const keys = new Set(copilotKnobs.catalog().map((knob) => `${knob.kind} ${knob.key}`));
    for (const key of [
      'setting model',
      'setting effortLevel',
      'env COPILOT_HOME',
      'flag --model',
    ]) {
      expect(keys.has(key)).toBe(true);
    }
    expect(copilotKnobs.envPrefix?.test('COPILOT_OTEL_ENABLED')).toBe(true);
    expect(copilotKnobs.envBlock).toBeNull();
  });
});

describe('copilotLaunchOverrides', () => {
  it('turns a profile into Copilot flags', () => {
    expect(
      copilotLaunchOverrides(
        profile({ model: 'gpt-5.4', effort: 'high', permissionMode: 'plan', env: { A: '1' } }),
      ),
    ).toStrictEqual({
      env: { A: '1' },
      extraArgs: { model: 'gpt-5.4', 'reasoning-effort': 'high', mode: 'plan' },
      config: [],
    });
  });

  it('starts allow all with --allow-all, and lets the profile flags win', () => {
    expect(
      copilotLaunchOverrides(
        profile({ permissionMode: 'allow-all', model: 'a', extraArgs: ['--model', 'b', '--plan'] }),
      ).extraArgs,
    ).toStrictEqual({ model: 'b', 'allow-all': null, plan: null });
    expect(copilotLaunchOverrides(profile()).extraArgs).toStrictEqual({});
  });
});
