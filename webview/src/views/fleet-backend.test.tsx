import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { FleetState } from '../../../src/shared/protocol.js';
import { twoAgents } from '../../test/fixtures-agents.js';
import { fleetState, session } from '../../test/fixtures.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';

import { FleetView } from './fleet-view.js';

const withBridge: FleetState = {
  ...fleetState,
  sessions: [
    ...fleetState.sessions,
    session({ id: 'b1', title: 'Grade lab 3', model: 'global.anthropic.claude-opus-5-5' }),
  ],
};

const withCodex: FleetState = {
  ...withBridge,
  sessions: [
    ...withBridge.sessions,
    session({ id: 'c1', agent: 'codex', title: 'Port the parser', model: 'gpt-6' }),
  ],
};

function flatApi(): FakeApi {
  return new FakeApi({ 'fleet.groupByProject': false });
}

function tipOf(title: string, selector: string): string | null {
  const row = screen.getByText(title, { selector: '.row-title' }).closest('tr');
  return row?.querySelector<HTMLElement>(selector)?.dataset['tip'] ?? null;
}

describe('FleetView backend logos', () => {
  it('marks Claude Code sessions with the backend their replies came from', async () => {
    const { container } = renderView(<FleetView state={withBridge} />, flatApi());
    expect(tipOf('Refactor parser', '.backend-mark')).toBe('Backend: Anthropic');
    expect(tipOf('Grade lab 3', '.backend-mark')).toBe('Backend: boisestate.ai');
    await expectAccessible(container);
  });

  it('puts the logo in the agent mark when rows name their agent', () => {
    renderView(<FleetView state={withCodex} />, flatApi(), twoAgents);
    expect(tipOf('Grade lab 3', '.agent-mark')).toMatch(/^Agent: Claude Code.* on boisestate\.ai$/);
    expect(tipOf('Grade lab 3', '.backend-mark')).toBeNull();
    expect(tipOf('Port the parser', '.agent-mark')).not.toContain(' on ');
    expect(tipOf('Port the parser', '.backend-mark')).toBeNull();
  });
});
