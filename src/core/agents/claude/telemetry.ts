// Claude Code's telemetry behind the telemetry facet. Claude reads its OTLP
// settings from the env block in settings.json, and its exports carry
// claude_code.* event names, which otel/decode.ts reads.

import path from 'node:path';

import { writeSetting } from '../../knobs/write.js';
import { decode } from '../../otel/decode.js';
import { TELEMETRY_ENV_KEYS, telemetryEnv } from '../../otel/env.js';
import type { TelemetryFacet } from '../talk-types.js';
import type { AgentDirs, SettingsWriteResult } from '../types.js';

/** Writes each env key in turn and stops at the first failure. */
async function writeEnv(
  dirs: AgentDirs,
  entries: readonly (readonly [string, string | undefined])[],
): Promise<SettingsWriteResult> {
  const file = path.join(dirs.configDir, 'settings.json');
  for (const [key, value] of entries) {
    const result = await writeSetting({ file, keyPath: `env.${key}`, value });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
  }
  return { ok: true };
}

export const claudeTelemetry: TelemetryFacet = {
  enable: async (dirs, port) => writeEnv(dirs, Object.entries(telemetryEnv(port))),
  disable: async (dirs) =>
    writeEnv(
      dirs,
      TELEMETRY_ENV_KEYS.map((key) => [key, undefined]),
    ),
  decode,
};
