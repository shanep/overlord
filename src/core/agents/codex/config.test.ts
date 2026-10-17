import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { catalogEnvKeys } from '../../knobs/catalog.js';
import { computeEffective } from '../../knobs/effective.js';
import type { SettingsPlace } from '../../knobs/facet.js';
import { loadLayers } from '../../knobs/layers.js';
import { writeSetting } from '../../knobs/write.js';

import { codexKnobs } from './config.js';

const USER = '# my settings\nmodel = "gpt-6-luna"  # keep\n\n[tui]\nnotifications = true\n';

describe('codexKnobs', () => {
  let dir: string;
  let home: string;
  let repo: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-codex-knobs-'));
    home = path.join(dir, 'codex-home');
    repo = path.join(dir, 'repo');
    await mkdir(home, { recursive: true });
    await mkdir(path.join(repo, '.codex'), { recursive: true });
    await writeFile(path.join(repo, '.codex', 'config.toml'), 'model = "gpt-6-sol"\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function place(): SettingsPlace {
    return {
      paths: { home: dir, managedDir: dir, userSettings: path.join(dir, 'unused.json') },
      projectDir: repo,
      env: { CODEX_HOME: home },
    };
  }

  async function load(): Promise<ReturnType<typeof computeEffective>> {
    const layers = await loadLayers({
      knobs: codexKnobs,
      ...place(),
      env: { CODEX_HOME: home, CODEX_SQLITE_HOME: '/db' },
      envKeys: catalogEnvKeys(codexKnobs.catalog()),
    });
    expect(layers.filter((layer) => layer.error !== null)).toStrictEqual([]);
    return computeEffective(layers, codexKnobs);
  }

  function fileOf(layer: string): string | null {
    const source = codexKnobs.layers.find((item) => item.layer === layer);
    return source?.kind === 'file' ? source.file(place()) : null;
  }

  it('reads the project file only once the user config.toml trusts the project', async () => {
    await writeFile(path.join(home, 'config.toml'), USER);
    expect(fileOf('project')).toBeNull();
    let effective = await load();
    expect(effective.find((item) => item.key === 'model')).toMatchObject({
      value: 'gpt-6-luna',
      layer: 'user',
    });
    expect(effective.find((item) => item.key === 'env.CODEX_SQLITE_HOME')?.value).toBe('/db');
    await writeFile(
      path.join(home, 'config.toml'),
      `${USER}\n[projects."${repo}"]\ntrust_level = "trusted"\n`,
    );
    expect(fileOf('project')).toBe(path.join(repo, '.codex', 'config.toml'));
    effective = await load();
    expect(effective.find((item) => item.key === 'model')).toMatchObject({
      value: 'gpt-6-sol',
      layer: 'project',
    });
  });

  it('saves a knob for terminal sessions with the targeted TOML editor', async () => {
    const file = path.join(home, 'config.toml');
    await writeFile(file, USER);
    expect(fileOf('user')).toBe(file);
    const result = await writeSetting({
      file,
      keyPath: 'model_reasoning_effort',
      value: 'high',
      format: 'toml',
    });
    expect(result.ok).toBe(true);
    const text = await readFile(file, 'utf8');
    expect(text.startsWith('# my settings\nmodel = "gpt-6-luna"  # keep\n')).toBe(true);
    expect(text).toContain('model_reasoning_effort = "high"');
    expect(await readFile(`${file}.bak`, 'utf8')).toBe(USER);
  });

  it('has a catalog of Codex settings, env vars and flags from its docs', () => {
    const keys = new Set(codexKnobs.catalog().map((knob) => `${knob.kind} ${knob.key}`));
    for (const key of [
      'setting model',
      'setting model_reasoning_effort',
      'setting sandbox_mode',
      'setting developer_instructions',
      'setting otel.exporter',
      'env CODEX_HOME',
      'flag --model',
      'flag --dangerously-bypass-hook-trust',
    ]) {
      expect(keys.has(key)).toBe(true);
    }
    expect(codexKnobs.catalog().some((knob) => knob.key.includes('<'))).toBe(false);
    expect(codexKnobs.envBlock).toBeNull();
  });
});
