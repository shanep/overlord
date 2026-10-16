import { describe, expect, it } from 'vitest';

import { EventBus } from '../../bus.js';
import { OverlordStore } from '../../store/store.js';
import { agent, immediateScheduler, permissionRequest, session } from '../test-helpers/fixtures.js';

import { buildProperties } from './properties.js';

function setup(): { bus: EventBus; store: OverlordStore } {
  const bus = new EventBus();
  return { bus, store: new OverlordStore(bus, { scheduler: immediateScheduler }) };
}

describe('properties view', () => {
  it('is empty when no CLI tab is active', () => {
    const { store } = setup();
    expect(buildProperties(store, [permissionRequest('p1')], null)).toStrictEqual({
      sessionId: null,
      session: null,
      agents: [],
      pendingPermissions: [],
    });
  });

  it('keeps the id of a session Claude Code has not reported yet', () => {
    const { store } = setup();
    expect(buildProperties(store, [], 'new')).toStrictEqual({
      sessionId: 'new',
      session: null,
      agents: [],
      pendingPermissions: [],
    });
  });

  it('gathers the session, its subagents and only its own pending permissions', () => {
    const { bus, store } = setup();
    bus.emit('session.upserted', session('s1'));
    bus.emit('agent.upserted', agent('s1', 's1'));
    bus.emit('agent.upserted', agent('s1', 'sub'));
    const mine = permissionRequest('p1');
    const other = permissionRequest('p2', { sessionId: 's2' });
    const state = buildProperties(store, [mine, other], 's1');
    expect(state.sessionId).toBe('s1');
    expect(state.session).toStrictEqual(session('s1'));
    expect(state.agents.map((item) => item.id)).toStrictEqual(['sub']);
    expect(state.pendingPermissions).toStrictEqual([mine]);
  });
});
