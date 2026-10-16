import { describe, expect, it } from 'vitest';

import { EventBus } from '../../bus.js';
import { OverlordStore } from '../../store/store.js';
import {
  agent,
  immediateScheduler,
  NOW,
  permissionRequest,
  session,
} from '../test-helpers/fixtures.js';

import { buildProperties } from './properties.js';

function noPid(): null {
  return null;
}

function pidOf(sessionId: string): number | null {
  return sessionId === 's1' ? 4242 : null;
}

function setup(): { bus: EventBus; store: OverlordStore } {
  const bus = new EventBus();
  return { bus, store: new OverlordStore(bus, { scheduler: immediateScheduler }) };
}

describe('properties view', () => {
  it('is empty when no CLI tab is active', () => {
    const { store } = setup();
    expect(buildProperties(store, [permissionRequest('p1')], null, noPid)).toStrictEqual({
      sessionId: null,
      session: null,
      agents: [],
      pendingPermissions: [],
      health: null,
    });
  });

  it('keeps the id of a session Claude Code has not reported yet', () => {
    const { store } = setup();
    expect(buildProperties(store, [], 'new', noPid)).toStrictEqual({
      sessionId: 'new',
      session: null,
      agents: [],
      pendingPermissions: [],
      health: null,
    });
  });

  it('gathers the session, its subagents and only its own pending permissions', () => {
    const { bus, store } = setup();
    bus.emit('session.upserted', session('s1'));
    bus.emit('agent.upserted', agent('s1', 's1'));
    bus.emit('agent.upserted', agent('s1', 'sub'));
    const mine = permissionRequest('p1');
    const other = permissionRequest('p2', { sessionId: 's2' });
    const state = buildProperties(store, [mine, other], 's1', noPid);
    expect(state.sessionId).toBe('s1');
    expect(state.session).toStrictEqual(session('s1'));
    expect(state.agents.map((item) => item.id)).toStrictEqual(['sub']);
    expect(state.pendingPermissions).toStrictEqual([mine]);
  });

  it('shows the live process id, which the transcript does not know', () => {
    const { bus, store } = setup();
    bus.emit('session.upserted', session('s1'));
    expect(buildProperties(store, [], 's1', pidOf).session?.pid).toBe(4242);
    expect(buildProperties(store, [], 's1', noPid).session?.pid).toBeNull();
    expect(buildProperties(store, [], 'missing', pidOf).session).toBeNull();
  });

  it('judges health from the main thread only', () => {
    const { bus, store } = setup();
    bus.emit('session.upserted', session('s1'));
    bus.emit('compaction.recorded', { sessionId: 's1', agentId: 's1', at: NOW });
    bus.emit('compaction.recorded', { sessionId: 's1', agentId: 'sub', at: NOW });
    const health = buildProperties(store, [], 's1', noPid).health;
    expect(health?.metrics.compactions).toBe(1);
    expect(health?.signals.map((signal) => signal.id)).toStrictEqual(['compactions']);
  });
});
