import { describe, expect, it } from 'vitest';

import { contextState, knobsState } from '../test/fixtures-context.js';
import { configState, launcherState, sessionsState, usageState } from '../test/fixtures-tools.js';
import { agentState, fleetState } from '../test/fixtures.js';

import { isHostToWebview } from './host-message.js';

describe('isHostToWebview', () => {
  it.each([
    ['fleet', fleetState],
    ['agent', agentState],
    ['context', contextState],
    ['knobs', knobsState],
    ['launcher', launcherState],
    ['sessions', sessionsState],
    ['config', configState],
    ['usage', usageState],
  ])('accepts a valid %s state', (view, state) => {
    expect(isHostToWebview({ type: 'state', view, state, agents: [] })).toBe(true);
  });

  it('accepts null where the state allows it', () => {
    const state = { ...agentState, agent: null, session: null };
    expect(isHostToWebview({ type: 'state', view: 'agent', state, agents: [] })).toBe(true);
    expect(
      isHostToWebview({
        type: 'state',
        view: 'context',
        state: { snapshot: null, sessions: [] },
        agents: [],
      }),
    ).toBe(true);
  });

  it('rejects anything that is not a state envelope', () => {
    expect(isHostToWebview(null)).toBe(false);
    expect(isHostToWebview('state')).toBe(false);
    expect(isHostToWebview({ type: 'patch', view: 'fleet', state: fleetState })).toBe(false);
    expect(isHostToWebview({ type: 'state', view: 'htop', state: fleetState })).toBe(false);
    expect(isHostToWebview({ type: 'state', view: 'fleet', state: [] })).toBe(false);
    // The host always sends the agent list.
    expect(isHostToWebview({ type: 'state', view: 'fleet', state: fleetState })).toBe(false);
  });

  it('rejects a state with a field of the wrong shape', () => {
    expect(
      isHostToWebview({
        type: 'state',
        view: 'fleet',
        state: { ...fleetState, sessions: {} },
        agents: [],
      }),
    ).toBe(false);
    expect(
      isHostToWebview({
        type: 'state',
        view: 'fleet',
        state: { ...fleetState, rateLimits: null },
        agents: [],
      }),
    ).toBe(false);
    expect(
      isHostToWebview({
        type: 'state',
        view: 'fleet',
        state: { ...fleetState, spendPerHourUsd: '3' },
        agents: [],
      }),
    ).toBe(false);
    expect(
      isHostToWebview({
        type: 'state',
        view: 'agent',
        state: { ...agentState, agent: 'a1' },
        agents: [],
      }),
    ).toBe(false);
  });

  it('rejects a state for a different view', () => {
    expect(isHostToWebview({ type: 'state', view: 'usage', state: fleetState, agents: [] })).toBe(
      false,
    );
  });
});
