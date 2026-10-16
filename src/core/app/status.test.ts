import { describe, expect, it } from 'vitest';

import type { FleetState } from '../../shared/protocol.js';

import { runningItems, statusLine, waitingBadge } from './status.js';
import { agent, permissionRequest, session } from './test-helpers/fixtures.js';

function fleet(overrides: Partial<FleetState> = {}): FleetState {
  return {
    sessions: [],
    agents: [],
    pendingPermissions: [],
    places: {},
    activeSessionId: null,
    rateLimits: { fiveHourPct: null, sevenDayPct: null, resetsAt: null },
    spendPerHourUsd: 0,
    ...overrides,
  };
}

describe('statusLine', () => {
  it('shows running sessions and spend', () => {
    expect(statusLine(fleet())).toBe('Overlord: 0 running, $0.00/h');
  });

  it('adds waiting sessions and the 5 hour limit when known', () => {
    const line = statusLine(
      fleet({
        sessions: [
          session('a'),
          session('b'),
          session('c', { state: 'waiting' }),
          session('d', { state: 'idle' }),
        ],
        spendPerHourUsd: 1.204,
        rateLimits: { fiveHourPct: 0.406, sevenDayPct: 0.1, resetsAt: null },
      }),
    );
    expect(line).toBe('Overlord: 2 running, 1 waiting, $1.20/h, 5h 41%');
  });
});

describe('waitingBadge', () => {
  it('shows nothing when no session waits', () => {
    const quiet = fleet({ sessions: [session('a'), session('b', { state: 'done' })] });
    expect(waitingBadge(quiet)).toBeUndefined();
  });

  it('counts each session waiting on an answer or a permission once', () => {
    const request = { ...permissionRequest('p1'), sessionId: 'b' };
    const twin = { ...permissionRequest('p2'), sessionId: 'a' };
    const busy = fleet({
      sessions: [session('a', { state: 'waiting' }), session('b'), session('c')],
      pendingPermissions: [request, twin],
    });
    expect(waitingBadge(busy)).toStrictEqual({ value: 2, tooltip: '2 sessions waiting on you' });
    const one = fleet({ sessions: [session('a', { state: 'waiting' })] });
    expect(waitingBadge(one)).toStrictEqual({ value: 1, tooltip: '1 session waiting on you' });
  });
});

describe('runningItems', () => {
  it('lists running and waiting sessions with their active subagents', () => {
    const items = runningItems(
      fleet({
        sessions: [
          session('s1', { title: 'Build' }),
          session('s2', { state: 'waiting', title: '' }),
          session('s3', { state: 'done' }),
        ],
        agents: [
          agent('s1', 's1'),
          agent('s1', 'a1', { agentType: 'Explore', currentTool: 'Grep' }),
          agent('s1', 'a2', { agentType: 'Plan', state: 'waiting' }),
          agent('s1', 'a3', { state: 'done' }),
          agent('s3', 'a4'),
        ],
      }),
    );
    expect(items).toStrictEqual([
      {
        id: 's1',
        sessionId: 's1',
        agentId: 's1',
        label: 'Build',
        description: 'running, 2 subagents',
        state: 'running',
        children: [
          {
            id: 's1/a1',
            sessionId: 's1',
            agentId: 'a1',
            label: 'Explore',
            description: 'Grep',
            state: 'running',
            children: [],
          },
          {
            id: 's1/a2',
            sessionId: 's1',
            agentId: 'a2',
            label: 'Plan',
            description: 'waiting',
            state: 'waiting',
            children: [],
          },
        ],
      },
      {
        id: 's2',
        sessionId: 's2',
        agentId: 's2',
        label: 's2',
        description: 'waiting',
        state: 'waiting',
        children: [],
      },
    ]);
  });

  it('shows the short id when a session has no title', () => {
    const [item] = runningItems(fleet({ sessions: [session('0123456789', { title: '' })] }));
    expect(item?.label).toBe('01234567');
  });
});
