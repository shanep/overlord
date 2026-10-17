import { describe, expect, it } from 'vitest';

import type { SessionPlace, SessionState } from '../../../src/shared/model.js';
import { fleetState, session } from '../../test/fixtures.js';

import type { FleetRow } from './fleet-rows.js';
import { buildFleetTree } from './fleet-rows.js';
import { isWindowless } from './windowless.js';

function sessionRow(state: SessionState, place: SessionPlace | null): FleetRow {
  const tree = buildFleetTree({
    ...fleetState,
    sessions: [session({ id: 'z', state })],
    agents: [],
    places: place === null ? {} : { z: place },
  });
  const row = tree[0]?.row;
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

describe('isWindowless', () => {
  it('marks a quiet session no terminal shows, since the fleet lets it go', () => {
    expect(isWindowless(sessionRow('idle', 'background'))).toBe(true);
    expect(isWindowless(sessionRow('done', null))).toBe(true);
    expect(isWindowless(sessionRow('idle', 'vscode'))).toBe(false);
    expect(isWindowless(sessionRow('done', 'terminal'))).toBe(false);
    expect(isWindowless(sessionRow('running', null))).toBe(false);
    expect(isWindowless(sessionRow('waiting', 'background'))).toBe(false);
  });

  it('leaves a launched session alone, since it stays until removed by hand', () => {
    expect(isWindowless({ ...sessionRow('done', null), launched: true })).toBe(false);
  });

  it('leaves agent and project rows alone', () => {
    const quiet = sessionRow('done', null);
    expect(isWindowless({ ...quiet, kind: 'agent' })).toBe(false);
    expect(isWindowless({ ...quiet, kind: 'project' })).toBe(false);
  });
});
