import { describe, expect, it } from 'vitest';

import { LOGS_INTERVAL_MS, METRIC_INTERVAL_MS, TELEMETRY_ENV_KEYS, telemetryEnv } from './env.js';

describe('telemetryEnv', () => {
  it('points metrics and logs at the local receiver over http/json', () => {
    expect(telemetryEnv(4318)).toStrictEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
      OTEL_LOGS_EXPORT_INTERVAL: '2000',
    });
    expect(METRIC_INTERVAL_MS).toBe(10_000);
    expect(LOGS_INTERVAL_MS).toBe(2000);
  });

  it('adds beta traces on request', () => {
    expect(
      telemetryEnv(1, { traces: true, metricIntervalMs: 100, logsIntervalMs: 500 }),
    ).toStrictEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      OTEL_METRIC_EXPORT_INTERVAL: '100',
      OTEL_LOGS_EXPORT_INTERVAL: '500',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_TRACES_EXPORT_INTERVAL: '500',
    });
    expect(Object.keys(telemetryEnv(65_535, { traces: false }))).toHaveLength(7);
  });

  it('never turns on content logging', () => {
    const env = telemetryEnv(9000, { traces: true });
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/^OTEL_LOG_/u);
    }
  });

  it('lists every key it can set', () => {
    expect(
      [...TELEMETRY_ENV_KEYS].toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(
      Object.keys(telemetryEnv(9000, { traces: true })).toSorted((left, right) =>
        left.localeCompare(right),
      ),
    );
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN])('rejects port %d', (port) => {
    expect(() => telemetryEnv(port)).toThrow(RangeError);
  });

  it('names the bad port', () => {
    expect(() => telemetryEnv(0)).toThrow('port must be an integer from 1 to 65535, got 0');
  });

  it('rejects intervals that are too short or fractional', () => {
    expect(() => telemetryEnv(9000, { metricIntervalMs: 99 })).toThrow(
      'export interval must be a whole number of at least 100 ms, got 99',
    );
    expect(() => telemetryEnv(9000, { logsIntervalMs: 150.5 })).toThrow(RangeError);
  });
});
