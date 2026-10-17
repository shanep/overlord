// One receiver serves every agent, so each export goes to the decoder of the
// agent that sent it. Agents name themselves in the OTLP resource's
// service.name: Claude Code says claude-code, Codex says codex_exec or the
// app-server client's name.

import type { OtlpSignal, TelemetryDecode } from './decode.js';
import { attributesOf, readString } from './otlp.js';

const GROUPS: Readonly<Record<OtlpSignal, string>> = {
  logs: 'resourceLogs',
  metrics: 'resourceMetrics',
  traces: 'resourceSpans',
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The service.name of an export's first resource, or null when it has none. */
export function serviceName(signal: OtlpSignal, body: unknown): string | null {
  const groups = isRecord(body) ? body[GROUPS[signal]] : undefined;
  const first: unknown = Array.isArray(groups) ? groups[0] : undefined;
  const resource = isRecord(first) ? first['resource'] : undefined;
  const list = isRecord(resource) ? resource['attributes'] : undefined;
  return Array.isArray(list) ? readString(attributesOf(list), 'service.name') : null;
}

/** A decoder that hands each export to the decoder its service.name picks, else to the fallback. */
export function decodeByService(
  pick: (serviceName: string) => TelemetryDecode | null,
  fallback: TelemetryDecode,
): TelemetryDecode {
  return (signal, body, now) => {
    const name = serviceName(signal, body);
    const decode = name === null ? null : pick(name);
    return (decode ?? fallback)(signal, body, now);
  };
}
