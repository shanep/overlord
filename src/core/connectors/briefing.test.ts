import { describe, expect, it } from 'vitest';

import type { Connector } from '../../shared/connectors.js';

import { CHECK_RULE, connectorBriefing } from './briefing.js';

function connector(name: string, status: Connector['status'], detail = 'Connected.'): Connector {
  return { id: `mcp:${name}`, name, kind: 'mcp', target: '', status, detail, fix: null };
}

const time = (at: number): string => `t${String(at)}`;

describe('connectorBriefing', () => {
  it('gives only the rule before the first check', () => {
    expect(connectorBriefing({ connectors: [], checkedAt: null }, time)).toBe(
      `Overlord connector check. ${CHECK_RULE}`,
    );
    expect(connectorBriefing({ connectors: [], checkedAt: 5 }, time)).toBe(
      `Overlord connector check. ${CHECK_RULE}`,
    );
  });

  it('lists what is not ready first, with what to do, then what is ready', () => {
    const text = connectorBriefing(
      {
        checkedAt: 7,
        connectors: [
          connector('Gmail', 'ok'),
          connector('Claude in Chrome', 'missing', 'No Chrome is connected.'),
          connector('sentry', 'needs-auth', 'Needs a sign in.'),
        ],
      },
      time,
    );
    expect(text).toBe(
      [
        'Overlord connector check. Status at t7; it may have changed since.',
        'Not ready:',
        '- Claude in Chrome: not available. No Chrome is connected.',
        '- sentry: needs sign in. Needs a sign in.',
        'Ready:',
        '- Gmail: ready',
        CHECK_RULE,
      ].join('\n'),
    );
  });

  it('says so when everything is ready, and leaves out an empty ready list', () => {
    expect(connectorBriefing({ checkedAt: 1, connectors: [connector('a', 'ok')] }, time)).toContain(
      'Every connector was ready.\nReady:\n- a: ready',
    );
    expect(
      connectorBriefing({ checkedAt: 1, connectors: [connector('b', 'failed', 'Down.')] }, time),
    ).not.toContain('Ready:');
  });
});
