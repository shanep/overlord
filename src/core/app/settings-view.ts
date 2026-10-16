// Reads what the app needs from Claude Code settings files: the context
// resolver's view of every layer, and whether local telemetry is switched on.

import type { EffectiveValue } from '../../shared/model.js';
import type { ContextSettingsView, InstructionFilesMode } from '../context/types.js';
import { REDACTED } from '../knobs/effective.js';
import { isArray, isPlainObject } from '../knobs/json.js';
import type { LayerData } from '../knobs/layers.js';
import { readSettingsFile } from '../knobs/layers.js';
import type { ClaudePaths } from '../paths.js';

type Env = Readonly<Record<string, string | undefined>>;

const INSTRUCTION_FILES: readonly InstructionFilesMode[] = [
  'claude-md-or-agents-md',
  'claude-md-and-agents-md',
  'claude-md',
  'managed-only',
];

function effectiveValue(effective: readonly EffectiveValue[], key: string): unknown {
  return effective.find((item) => item.key === key)?.value;
}

function excludesOf(layer: LayerData): readonly string[] {
  const value = layer.values['claudeMdExcludes'];
  return isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/** The process env with every settings `env` value on top, as a session would see it. */
export function sessionEnv(effective: readonly EffectiveValue[], env: Env): Env {
  const merged: Record<string, string | undefined> = { ...env };
  for (const item of effective) {
    if (item.key.startsWith('env.') && typeof item.value === 'string' && item.value !== REDACTED) {
      merged[item.key.slice(4)] = item.value;
    }
  }
  return merged;
}

export function contextSettings(
  layers: readonly LayerData[],
  effective: readonly EffectiveValue[],
  env: Env,
): ContextSettingsView {
  const enabled = effectiveValue(effective, 'autoMemoryEnabled');
  const directory = effectiveValue(effective, 'autoMemoryDirectory');
  const files = effectiveValue(effective, 'instructionFiles');
  return {
    claudeMdExcludes: layers.flatMap((layer) => {
      const patterns = excludesOf(layer);
      return patterns.length === 0 ? [] : [{ layer: layer.layer, patterns }];
    }),
    autoMemoryEnabled: typeof enabled === 'boolean' ? enabled : null,
    autoMemoryDirectory: typeof directory === 'string' ? directory : null,
    instructionFiles: INSTRUCTION_FILES.find((mode) => mode === files) ?? null,
    env: sessionEnv(effective, env),
  };
}

/** The `env` block of ~/.claude/settings.json, string values only. */
export async function userSettingsEnv(
  paths: Pick<ClaudePaths, 'userSettings'>,
): Promise<Readonly<Record<string, string>>> {
  const layer = await readSettingsFile('user', paths.userSettings);
  const env = layer.values['env'];
  if (!isPlainObject(env)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

const LOOPBACK_ENDPOINT = 'http://127.0.0.1:';

/** True when user settings turn telemetry on and point it at a loopback receiver. */
export function telemetryActive(env: Readonly<Record<string, string>>): boolean {
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '';
  return env['CLAUDE_CODE_ENABLE_TELEMETRY'] === '1' && endpoint.startsWith(LOOPBACK_ENDPOINT);
}
