import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EffectiveValue } from '../../shared/model.js';
import type { LayerData } from '../knobs/layers.js';

import { contextSettings, sessionEnv, telemetryActive, userSettingsEnv } from './settings-view.js';
import { makeEnv, writeJson, writeText } from './test-helpers/fixtures.js';

function value(key: string, data: unknown): EffectiveValue {
  return { key, value: data, layer: 'user', chain: [] };
}

function layer(name: LayerData['layer'], values: LayerData['values']): LayerData {
  return { layer: name, file: null, values, error: null };
}

describe('sessionEnv', () => {
  it('puts settings env strings over the process env and skips redacted or non string values', () => {
    const env = sessionEnv(
      [
        value('env.A', 'from-settings'),
        value('env.SECRET_TOKEN', '<redacted>'),
        value('env.NUM', 3),
        value('model', 'opus'),
        value('envy', 'x'),
      ],
      { A: 'process', SECRET_TOKEN: 'kept', B: 'b' },
    );
    expect(env).toStrictEqual({ A: 'from-settings', SECRET_TOKEN: 'kept', B: 'b' });
  });
});

describe('contextSettings', () => {
  it('collects excludes per layer and reads typed values', () => {
    const view = contextSettings(
      [
        layer('project', { claudeMdExcludes: ['**/vendor/**', 5] }),
        layer('user', { claudeMdExcludes: [] }),
        layer('managed', { claudeMdExcludes: 'not a list' }),
        layer('env', {}),
      ],
      [
        value('autoMemoryEnabled', false),
        value('autoMemoryDirectory', '~/mem'),
        value('instructionFiles', 'claude-md'),
      ],
      { HOME: '/h' },
    );
    expect(view).toStrictEqual({
      claudeMdExcludes: [{ layer: 'project', patterns: ['**/vendor/**'] }],
      autoMemoryEnabled: false,
      autoMemoryDirectory: '~/mem',
      instructionFiles: 'claude-md',
      env: { HOME: '/h' },
    });
  });

  it('leaves values of the wrong type unset', () => {
    const view = contextSettings(
      [],
      [
        value('autoMemoryEnabled', 'yes'),
        value('autoMemoryDirectory', 4),
        value('instructionFiles', 'everything'),
      ],
      {},
    );
    expect(view.autoMemoryEnabled).toBeNull();
    expect(view.autoMemoryDirectory).toBeNull();
    expect(view.instructionFiles).toBeNull();
    expect(view.claudeMdExcludes).toStrictEqual([]);
  });

  it('knows every instruction files mode', () => {
    for (const mode of [
      'claude-md-or-agents-md',
      'claude-md-and-agents-md',
      'claude-md',
      'managed-only',
    ]) {
      expect(contextSettings([], [value('instructionFiles', mode)], {}).instructionFiles).toBe(
        mode,
      );
    }
  });
});

describe('userSettingsEnv', () => {
  it('returns only string env values from user settings', async () => {
    const env = await makeEnv();
    const userSettings = path.join(env.root, 'settings.json');
    await expect(userSettingsEnv({ userSettings })).resolves.toStrictEqual({});
    await writeJson(userSettings, { env: { A: '1', B: 2 } });
    await expect(userSettingsEnv({ userSettings })).resolves.toStrictEqual({ A: '1' });
    await writeJson(userSettings, { env: ['A'] });
    await expect(userSettingsEnv({ userSettings })).resolves.toStrictEqual({});
    await writeText(userSettings, 'not json');
    await expect(userSettingsEnv({ userSettings })).resolves.toStrictEqual({});
  });
});

describe('telemetryActive', () => {
  it('needs telemetry on and a loopback endpoint', () => {
    const on = {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    };
    expect(telemetryActive(on)).toBe(true);
    expect(telemetryActive({ ...on, CLAUDE_CODE_ENABLE_TELEMETRY: '0' })).toBe(false);
    expect(
      telemetryActive({ ...on, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com' }),
    ).toBe(false);
    expect(telemetryActive({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' })).toBe(false);
    expect(telemetryActive({})).toBe(false);
  });
});
