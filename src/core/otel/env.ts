// The env block Overlord puts in user settings so Claude Code exports
// telemetry to the local receiver. Content gates (OTEL_LOG_USER_PROMPTS,
// OTEL_LOG_TOOL_DETAILS and the rest) are never set, so they stay off.

export interface TelemetryEnvOptions {
  /** Also export beta traces, which carry time to first token per request. */
  readonly traces?: boolean;
  readonly metricIntervalMs?: number;
  readonly logsIntervalMs?: number;
}

export const METRIC_INTERVAL_MS = 10_000;
export const LOGS_INTERVAL_MS = 2000;

/** Every key telemetryEnv can set, so turning telemetry off can remove them all. */
export const TELEMETRY_ENV_KEYS: readonly string[] = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'OTEL_TRACES_EXPORTER',
  'OTEL_TRACES_EXPORT_INTERVAL',
];

function interval(value: number | undefined, fallback: number): string {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < 100) {
    throw new RangeError(
      `export interval must be a whole number of at least 100 ms, got ${String(chosen)}`,
    );
  }
  return String(chosen);
}

export function telemetryEnv(
  port: number,
  options: TelemetryEnvOptions = {},
): Readonly<Record<string, string>> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`port must be an integer from 1 to 65535, got ${String(port)}`);
  }
  const logsInterval = interval(options.logsIntervalMs, LOGS_INTERVAL_MS);
  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(port)}`,
    OTEL_METRIC_EXPORT_INTERVAL: interval(options.metricIntervalMs, METRIC_INTERVAL_MS),
    OTEL_LOGS_EXPORT_INTERVAL: logsInterval,
  };
  if (options.traces === true) {
    env['CLAUDE_CODE_ENHANCED_TELEMETRY_BETA'] = '1';
    env['OTEL_TRACES_EXPORTER'] = 'otlp';
    env['OTEL_TRACES_EXPORT_INTERVAL'] = logsInterval;
  }
  return env;
}
