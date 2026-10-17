// Codex CLI's telemetry behind the telemetry facet. Codex reads [otel] only
// from the user config.toml, so:
//
// - Sessions Overlord starts get the export as `-c otel.*` overrides while the
//   receiver runs, and the file is not touched.
// - Terminal sessions started elsewhere only export once the user turns
//   telemetry on in Overlord's setup, which adds an [otel] block to
//   config.toml with the targeted editor (a .bak copy, every other byte
//   kept). Overlord never rewrites the file, and never touches an [otel] block
//   the user wrote.
//
// Only the log export is turned on. Traces from one short turn ran to almost
// 1 MB in the 0.163.0 fixtures and add nothing Overlord reads. Every log
// event carries user.email and user.account_id, which are dropped here and
// never stored, as are prompts and tool arguments and output.
// cspell:words otlp

import path from 'node:path';

import { parse } from 'smol-toml';

import { readOptional } from '../../knobs/atomic-file.js';
import type { ConfigOverride } from '../../knobs/facet.js';
import { editTomlFile, formatTomlValue, type TomlEdit } from '../../knobs/toml-edit.js';
import type { OtlpSignal } from '../../otel/decode.js';
import { decodeMetrics, decodeTraces } from '../../otel/decode.js';
import type { Attributes, OtlpLogRecord } from '../../otel/otlp.js';
import {
  attributesOf,
  logsRequestSchema,
  nanosToMs,
  readBool,
  readNumber,
  readString,
} from '../../otel/otlp.js';
import type { TelemetryRecord } from '../../otel/records.js';
import type { AgentDirs, SettingsWriteResult, TelemetryFacet } from '../talk-types.js';

/** The tag Overlord's [otel] block sets, which is how it knows the block is its own. */
export const OVERLORD_ENVIRONMENT = 'overlord';

/** Attributes that are personal or carry what the user and model wrote. */
const DROPPED: ReadonlySet<string> = new Set([
  'user.email',
  'user.account_id',
  'prompt',
  'arguments',
  'output',
]);

const PREFIX = 'codex.';

const EXPORTER = ['otel', 'exporter', 'otlp-http'];

function configFile(dirs: AgentDirs): string {
  return path.join(dirs.configDir, 'config.toml');
}

function logsEndpoint(port: number): string {
  return `http://127.0.0.1:${String(port)}/v1/logs`;
}

function scrub(attributes: Attributes): Attributes {
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => !DROPPED.has(key)));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    current = isRecord(current) ? current[key] : undefined;
  }
  return current;
}

/** The parsed user config.toml, {} when it is missing, or null when it does not parse. */
async function readConfig(dirs: AgentDirs): Promise<unknown> {
  const text = await readOptional(configFile(dirs));
  if (text === null) {
    return {};
  }
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/** True when the [otel] block is the one Overlord added. */
function isOurs(config: unknown): boolean {
  const endpoint = at(config, [...EXPORTER, 'endpoint']);
  return (
    at(config, ['otel', 'environment']) === OVERLORD_ENVIRONMENT &&
    typeof endpoint === 'string' &&
    /^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/u.test(endpoint)
  );
}

async function enable(dirs: AgentDirs, port: number): Promise<SettingsWriteResult> {
  const config = await readConfig(dirs);
  if (config === null) {
    return { ok: false, error: `${configFile(dirs)} does not parse as TOML, so Overlord left it.` };
  }
  const ours = isOurs(config);
  if (at(config, ['otel']) !== undefined && !ours) {
    return {
      ok: false,
      error: `${configFile(dirs)} already has its own [otel] settings, so Overlord left them as they are.`,
    };
  }
  const edits: readonly TomlEdit[] = ours
    ? [{ op: 'set', path: [...EXPORTER, 'endpoint'], value: logsEndpoint(port) }]
    : [
        {
          op: 'add-section',
          table: ['otel'],
          entries: [
            { key: ['environment'], value: OVERLORD_ENVIRONMENT },
            { key: ['log_user_prompt'], value: false },
          ],
        },
        {
          op: 'add-section',
          table: EXPORTER,
          entries: [
            { key: ['endpoint'], value: logsEndpoint(port) },
            { key: ['protocol'], value: 'json' },
          ],
        },
      ];
  const result = await editTomlFile(configFile(dirs), edits);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function disable(dirs: AgentDirs): Promise<SettingsWriteResult> {
  const config = await readConfig(dirs);
  if (config === null || !isOurs(config)) {
    return { ok: true };
  }
  const result = await editTomlFile(configFile(dirs), [
    { op: 'remove-section', table: EXPORTER },
    { op: 'remove-section', table: ['otel'] },
  ]);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * The export for one launch. Left out when the user's config.toml has [otel]
 * settings of its own, so a launch never overrides them.
 */
async function launchConfig(dirs: AgentDirs, port: number): Promise<readonly ConfigOverride[]> {
  const config = await readConfig(dirs);
  if (config === null || (at(config, ['otel']) !== undefined && !isOurs(config))) {
    return [];
  }
  const exporter = `{otlp-http={endpoint=${formatTomlValue(logsEndpoint(port))},protocol="json"}}`;
  return [
    { key: ['otel', 'environment'], value: OVERLORD_ENVIRONMENT },
    { key: ['otel', 'log_user_prompt'], value: false },
    { key: ['otel', 'exporter'], raw: exporter },
  ];
}

function logRecord(
  record: OtlpLogRecord,
  resource: Attributes,
  now: number,
): TelemetryRecord | null {
  const attributes = scrub(attributesOf(record.attributes));
  const event = readString(attributes, 'event.name') ?? '';
  if (!event.startsWith(PREFIX)) {
    return null;
  }
  const stamp = Date.parse(readString(attributes, 'event.timestamp') ?? '');
  const base = {
    time: Number.isFinite(stamp) ? stamp : (nanosToMs(record.timeUnixNano) ?? now),
    sessionId: readString(attributes, 'conversation.id'),
    attributes,
    resource,
  };
  const text = (key: string): string | null => readString(attributes, key);
  switch (event) {
    case 'codex.tool_result': {
      return {
        ...base,
        kind: 'tool_result',
        toolName: text('tool_name'),
        toolUseId: text('call_id'),
        success: readBool(attributes, 'success'),
        durationMs: readNumber(attributes, 'duration_ms'),
        errorType: null,
        decisionSource: null,
      };
    }
    case 'codex.tool_decision': {
      return {
        ...base,
        kind: 'tool_decision',
        toolName: text('tool_name'),
        toolUseId: text('call_id'),
        decision: text('decision'),
        source: text('source'),
      };
    }
    case 'codex.user_prompt': {
      return {
        ...base,
        kind: 'user_prompt',
        promptLength: readNumber(attributes, 'prompt_length'),
        promptId: null,
      };
    }
    default: {
      return { ...base, kind: 'event', name: event.slice(PREFIX.length) };
    }
  }
}

function decodeLogs(body: unknown, now: number): TelemetryRecord[] | null {
  const parsed = logsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  return (parsed.data.resourceLogs ?? []).flatMap((group) => {
    const resource = scrub(attributesOf(group.resource?.attributes));
    return (group.scopeLogs ?? []).flatMap((scope) =>
      (scope.logRecords ?? []).flatMap((record) => logRecord(record, resource, now) ?? []),
    );
  });
}

/** Metrics and spans as the shared decoder reads them, with the same fields dropped. */
function scrubbed(records: TelemetryRecord[] | null): TelemetryRecord[] | null {
  return (
    records?.map((record) => ({
      ...record,
      attributes: scrub(record.attributes),
      resource: scrub(record.resource),
      sessionId: record.sessionId ?? readString(record.attributes, 'conversation.id'),
    })) ?? null
  );
}

/**
 * Codex 0.163.0's exports. A codex.sse_event for each response has its
 * tokens and time to first token but no response id, so it cannot be matched
 * to the rollout's token_usage_record, and it stays an event: making it a
 * request would count every call twice.
 */
export function decodeCodex(
  signal: OtlpSignal,
  body: unknown,
  now: number,
): TelemetryRecord[] | null {
  if (signal === 'logs') {
    return decodeLogs(body, now);
  }
  return scrubbed(signal === 'metrics' ? decodeMetrics(body, now) : decodeTraces(body, now));
}

export const codexTelemetry: TelemetryFacet = {
  enable,
  disable,
  decode: decodeCodex,
  enabled: async (dirs) => isOurs(await readConfig(dirs)),
  launchConfig,
  // codex_exec, codex_cli_rs and the like, or "overlord", the name Overlord's app-server client gives.
  sends: (serviceName) => serviceName.startsWith('codex') || serviceName === 'overlord',
};
