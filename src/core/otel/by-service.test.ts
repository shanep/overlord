import { describe, expect, it } from 'vitest';

import { decodeByService, serviceName } from './by-service.js';
import type { TelemetryDecode } from './decode.js';

function logsFrom(service: string): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeLogs: [],
      },
    ],
  };
}

describe('serviceName', () => {
  it("reads the first resource's service.name for each signal", () => {
    expect(serviceName('logs', logsFrom('codex_exec'))).toBe('codex_exec');
    const metrics = {
      resourceMetrics: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }],
          },
        },
      ],
    };
    expect(serviceName('metrics', metrics)).toBe('claude-code');
    expect(serviceName('traces', { resourceSpans: [{}] })).toBeNull();
    expect(serviceName('logs', 'nope')).toBeNull();
  });
});

describe('decodeByService', () => {
  it('hands each export to the decoder its service picks, else to the fallback', () => {
    const seen: string[] = [];
    const named =
      (name: string): TelemetryDecode =>
      () => {
        seen.push(name);
        return [];
      };
    const decode = decodeByService(
      (service) => (service.startsWith('codex') ? named('codex') : null),
      named('claude'),
    );
    decode('logs', logsFrom('codex_exec'), 0);
    decode('logs', logsFrom('claude-code'), 0);
    decode('logs', {}, 0);
    expect(seen).toStrictEqual(['codex', 'claude', 'claude']);
  });
});
