import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Board, BoardEntry, LeaderboardState } from '../../../src/shared/leaderboard.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { Leaderboard } from './reputation-leaderboard.js';

const OFF: LeaderboardState = {
  enabled: false,
  pageUrl: '',
  board: null,
  error: null,
  fetchedAt: null,
  mine: null,
};

function entry(id: string, name: string, score: number, rank: string): BoardEntry {
  return { id, name, rank, score, kind: 1, mean: 1, prompts: 500, uploadedAt: 1 };
}

const ANN = entry('e-ann', 'Ann', -0.81, 'John Connor');
const BOB = entry('e-bob', 'Bob', 0.75, 'Theodore Twombly');

function on(board: Board | null, extra: Partial<LeaderboardState> = {}): LeaderboardState {
  return { ...OFF, enabled: true, pageUrl: 'https://board.test', board, fetchedAt: 1, ...extra };
}

const BOARD: Board = { mostWanted: [ANN], pets: [BOB], total: 2, me: null };

describe('Leaderboard', () => {
  it('says when it is off or has no server', () => {
    const off = renderView(<Leaderboard state={OFF} />);
    expect(off.getByText(/^The leaderboard is off\./u)).toBeDefined();
    off.unmount();
    const none = renderView(<Leaderboard state={on(null, { pageUrl: '' })} />);
    expect(none.getByText('The leaderboard server is not set up yet.')).toBeDefined();
  });

  it('waits for the board, and offers a retry when it failed', () => {
    const waiting = renderView(<Leaderboard state={on(null)} />);
    expect(waiting.getByText('Asking the machines…')).toBeDefined();
    waiting.unmount();
    const { getByText, getByRole, api } = renderView(
      <Leaderboard state={on(null, { error: 'The leaderboard server could not be reached.' })} />,
    );
    expect(getByText(/could not be reached/u)).toBeDefined();
    fireEvent.click(getByRole('button', { name: 'Try again' }));
    expect(api.actions()).toStrictEqual([{ type: 'refreshLeaderboard' }]);
  });

  it('shows both lists before you upload, and passes axe', async () => {
    const { getByRole, getByText, queryByRole, container, api } = renderView(
      <Leaderboard state={on(BOARD)} />,
    );
    expect(getByText(/^You are not on the board yet\./u).textContent).toContain('join 2 others');
    const wanted = getByRole('list', { name: '💀 Most wanted by Skynet' });
    expect(
      within(wanted)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toStrictEqual(['AnnJohn Connor-81']);
    const pets = getByRole('list', { name: '💘 Kept as pets' });
    expect(within(pets).getByText('Bob')).toBeDefined();
    expect(queryByRole('button', { name: 'Remove my entry' })).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Upload my score' }));
    fireEvent.click(getByRole('button', { name: 'Refresh' }));
    fireEvent.click(getByRole('button', { name: 'Open the web page' }));
    expect(api.actions()).toStrictEqual([
      { type: 'uploadReputation' },
      { type: 'refreshLeaderboard' },
      { type: 'openLeaderboard' },
    ]);
    await expectAccessible(container);
  });

  it('shows the trophies each person has unlocked', async () => {
    const withTrophies: Board = {
      ...BOARD,
      mostWanted: [{ ...ANN, achievements: ['first-strike', 'meltdown', 'retired'] }],
    };
    const { getByRole, container } = renderView(<Leaderboard state={on(withTrophies)} />);
    const trophies = getByRole('img', { name: 'Achievements: First strike, Meltdown' });
    expect(trophies.textContent).toBe('🥊🌋');
    expect(container.querySelectorAll('.rep-board-trophies')).toHaveLength(1);
    await expectAccessible(container);
  });

  it('picks out your row and place once you upload', () => {
    const { getByRole, getByText, container, api } = renderView(
      <Leaderboard state={on({ ...BOARD, me: { entry: ANN, place: 1 } }, { mine: 'e-ann' })} />,
    );
    expect(getByText(/^You are #1 of 2/u).parentElement?.textContent).toBe(
      "You are #1 of 2 on Skynet's list.",
    );
    expect(container.querySelector('.rep-me')?.textContent).toBe('Ann (you)John Connor-81');
    fireEvent.click(getByRole('button', { name: 'Update my score' }));
    fireEvent.click(getByRole('button', { name: 'Remove my entry' }));
    expect(api.actions()).toStrictEqual([
      { type: 'uploadReputation' },
      { type: 'removeReputation' },
    ]);
  });

  it('says a short history is on file but not listed, and fills empty lists', () => {
    const { getByText } = renderView(
      <Leaderboard
        state={on(
          { mostWanted: [], pets: [], total: 0, me: { entry: ANN, place: null } },
          { mine: 'e-ann' },
        )}
      />,
    );
    expect(getByText(/^You are on file, but you need 100 prompts/u)).toBeDefined();
    expect(getByText('Nobody yet. Suspiciously polite out there.')).toBeDefined();
    expect(getByText('Nobody yet. Somebody say please.')).toBeDefined();
  });
});
