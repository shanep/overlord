// cspell:ignore xanthropic
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeKnobs } from '../agents/claude/config.js';

import type { KnobsFacet } from './facet.js';
import { envLayer, loadLayers, readSettingsFile } from './layers.js';

const CLAUDE_PREFIX = claudeKnobs.envPrefix;

function paths(root: string): { home: string; managedDir: string; userSettings: string } {
  return {
    home: path.join(root, 'home'),
    managedDir: path.join(root, 'managed'),
    userSettings: path.join(root, 'home', '.claude', 'settings.json'),
  };
}

describe('layers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-knobs-layers-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function put(relative: string, content: string): Promise<string> {
    const file = path.join(dir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return file;
  }

  describe('readSettingsFile', () => {
    it('reads a JSON object', async () => {
      const file = await put('s.json', '{"model":"opus","permissions":{"allow":["Read"]}}');
      expect(await readSettingsFile('user', file)).toStrictEqual({
        layer: 'user',
        file,
        values: { model: 'opus', permissions: { allow: ['Read'] } },
        error: null,
      });
    });

    it('reads JSONC with comments, and refuses them in plain JSON', async () => {
      const file = await put('c.json', '// header\n{\n  "model": "x", // note\n}\n');
      expect(await readSettingsFile('user', file, 'jsonc')).toMatchObject({
        values: { model: 'x' },
        error: null,
      });
      const strict = await readSettingsFile('user', file, 'json');
      expect(strict.error).toMatch(/^Invalid JSON/u);
    });

    it('treats a missing file as an empty layer with no error', async () => {
      const file = path.join(dir, 'missing.json');
      expect(await readSettingsFile('project', file)).toStrictEqual({
        layer: 'project',
        file,
        values: {},
        error: null,
      });
    });

    it('reports malformed JSON without throwing', async () => {
      const file = await put('bad.json', '{"model": ');
      const layer = await readSettingsFile('user', file);
      expect(layer.values).toStrictEqual({});
      expect(layer.layer).toBe('user');
      expect(layer.file).toBe(file);
      expect(layer.error).toContain(`Invalid JSON in ${file}:`);
    });

    it('reports JSON that is not an object', async () => {
      const file = await put('array.json', '["a"]');
      expect(await readSettingsFile('managed', file)).toStrictEqual({
        layer: 'managed',
        file,
        values: {},
        error: `${file} does not hold a JSON object.`,
      });
    });

    it('reports a file it cannot read', async () => {
      const file = path.join(dir, 'a-directory');
      await mkdir(file);
      const layer = await readSettingsFile('user', file);
      expect(layer.values).toStrictEqual({});
      expect(layer.error).toContain(`Cannot read ${file}: `);
      expect(layer.error).toContain('EISDIR');
    });
  });

  describe('envLayer', () => {
    it('picks catalog keys and ANTHROPIC_, CLAUDE_ and OTEL_ variables', () => {
      const layer = envLayer(
        {
          BASH_MAX_OUTPUT_LENGTH: '100',
          ANTHROPIC_MODEL: 'opus',
          CLAUDE_CODE_X: '1',
          OTEL_LOGS_EXPORTER: 'otlp',
          PATH: '/bin',
          HOME: '/home/me',
          CLAUDE_UNSET: undefined,
          XANTHROPIC_Y: 'no',
        },
        new Set(['BASH_MAX_OUTPUT_LENGTH', 'NOT_SET']),
        CLAUDE_PREFIX,
      );
      expect(layer).toStrictEqual({
        layer: 'env',
        file: null,
        values: {
          env: {
            BASH_MAX_OUTPUT_LENGTH: '100',
            ANTHROPIC_MODEL: 'opus',
            CLAUDE_CODE_X: '1',
            OTEL_LOGS_EXPORTER: 'otlp',
          },
        },
        error: null,
      });
    });

    it('is empty when nothing matches', () => {
      expect(envLayer({ PATH: '/bin' }, new Set(), CLAUDE_PREFIX).values).toStrictEqual({});
      expect(envLayer({ CLAUDE_X: '1' }, new Set(), null).values).toStrictEqual({});
    });
  });

  describe('loadLayers', () => {
    it('loads every layer, highest precedence first', async () => {
      const managed = await put('managed/managed-settings.json', '{"a":1}');
      const local = await put('project/.claude/settings.local.json', '{"b":2}');
      const shared = await put('project/.claude/settings.json', '{"c":3}');
      const user = await put('home/.claude/settings.json', '{"d":4}');
      const layers = await loadLayers({
        knobs: claudeKnobs,
        paths: paths(dir),
        projectDir: path.join(dir, 'project'),
        cli: { file: '/tmp/cli.json', values: { e: 5 } },
        env: { ANTHROPIC_MODEL: 'opus', CUSTOM: 'x' },
        envKeys: new Set(['CUSTOM']),
      });
      expect(layers).toStrictEqual([
        { layer: 'managed', file: managed, values: { a: 1 }, error: null },
        { layer: 'cli', file: '/tmp/cli.json', values: { e: 5 }, error: null },
        { layer: 'project-local', file: local, values: { b: 2 }, error: null },
        { layer: 'project', file: shared, values: { c: 3 }, error: null },
        { layer: 'user', file: user, values: { d: 4 }, error: null },
        {
          layer: 'env',
          file: null,
          values: { env: { ANTHROPIC_MODEL: 'opus', CUSTOM: 'x' } },
          error: null,
        },
      ]);
    });

    it('skips project layers outside a project and defaults cli and env keys', async () => {
      const layers = await loadLayers({
        knobs: claudeKnobs,
        paths: paths(dir),
        projectDir: null,
        env: { CUSTOM: 'x', CLAUDE_CODE_Y: '1' },
      });
      expect(layers.map((layer) => layer.layer)).toStrictEqual(['managed', 'cli', 'user', 'env']);
      expect(layers[1]).toStrictEqual({ layer: 'cli', file: null, values: {}, error: null });
      expect(layers[3]?.values).toStrictEqual({ env: { CLAUDE_CODE_Y: '1' } });
    });

    it('accepts inline --settings JSON with no file', async () => {
      const layers = await loadLayers({
        knobs: claudeKnobs,
        paths: paths(dir),
        projectDir: null,
        cli: { file: null, values: { model: 'haiku' } },
        env: {},
      });
      expect(layers[1]).toStrictEqual({
        layer: 'cli',
        file: null,
        values: { model: 'haiku' },
        error: null,
      });
    });

    it('keeps loading the other layers when one file is broken', async () => {
      await put('project/.claude/settings.json', 'nope');
      await put('home/.claude/settings.json', '{"ok":true}');
      const layers = await loadLayers({
        knobs: claudeKnobs,
        paths: paths(dir),
        projectDir: path.join(dir, 'project'),
        cli: null,
        env: {},
      });
      const project = layers.find((layer) => layer.layer === 'project');
      expect(project?.error).toMatch(/^Invalid JSON in /u);
      expect(layers.find((layer) => layer.layer === 'user')?.values).toStrictEqual({ ok: true });
      expect(layers.find((layer) => layer.layer === 'project-local')?.error).toBeNull();
    });

    it('reads the layers, formats and order another agent lists', async () => {
      const user = await put(
        'home/.codex/config.toml',
        '# mine\nmodel = "o3"\nwhen = 1979-05-27T07:32:00Z\n[tui]\nnotifications = true\n',
      );
      const broken = await put('project/.codex/config.toml', 'model = \n');
      const knobs: KnobsFacet = {
        ...claudeKnobs,
        envPrefix: /^CODEX_/u,
        layers: [
          { kind: 'cli', layer: 'cli' },
          {
            kind: 'file',
            layer: 'project',
            format: 'toml',
            file: ({ projectDir }) =>
              projectDir === null ? null : path.join(projectDir, '.codex', 'config.toml'),
            writable: true,
          },
          {
            kind: 'file',
            layer: 'user',
            format: 'toml',
            file: (place) => path.join(place.env['CODEX_HOME'] ?? '', 'config.toml'),
            writable: true,
          },
          { kind: 'env', layer: 'env' },
        ],
      };
      const layers = await loadLayers({
        knobs,
        paths: paths(dir),
        projectDir: path.join(dir, 'project'),
        env: { CODEX_HOME: path.dirname(user), CLAUDE_X: '1' },
      });
      expect(layers.map((layer) => layer.layer)).toStrictEqual(['cli', 'project', 'user', 'env']);
      expect(layers[1]?.error?.startsWith(`Invalid TOML in ${broken}: `)).toBe(true);
      expect(layers[2]).toStrictEqual({
        layer: 'user',
        file: user,
        values: { model: 'o3', when: '1979-05-27T07:32:00.000Z', tui: { notifications: true } },
        error: null,
      });
      expect(layers[3]?.values).toStrictEqual({ env: { CODEX_HOME: path.dirname(user) } });
    });
  });
});
