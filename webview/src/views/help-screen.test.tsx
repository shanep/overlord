import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectAccessible, renderView } from '../../test/render.js';

import { PIECES, SCREEN_AREAS } from './help-screen-content.js';
import { ScreenSection } from './help-screen.js';
import { SessionsSection } from './help-sessions.js';

const MAP_NAME = /Overlord in a VS Code window/u;

describe('ScreenSection', () => {
  it('puts one marker on the map for every area, solid where Overlord draws', () => {
    const { getByRole } = renderView(<ScreenSection />);
    const map = getByRole('img', { name: MAP_NAME });
    const markers = [...map.querySelectorAll('.ext-marker')];
    expect(markers.map((marker) => marker.textContent)).toStrictEqual(
      SCREEN_AREAS.map((area) => String(area.number)),
    );
    expect(map.querySelectorAll('.ext-marker-used')).toHaveLength(
      SCREEN_AREAS.filter((area) => area.overlord !== null).length,
    );
  });

  it('numbers the areas 1 to n in order so they can be asked for by number', () => {
    expect(SCREEN_AREAS.map((area) => area.number)).toStrictEqual(
      SCREEN_AREAS.map((_, index) => index + 1),
    );
  });

  it('keeps every marker inside the window', () => {
    for (const area of SCREEN_AREAS) {
      expect(area.at.x).toBeGreaterThanOrEqual(12);
      expect(area.at.x).toBeLessThanOrEqual(948);
      expect(area.at.y).toBeGreaterThanOrEqual(12);
      expect(area.at.y).toBeLessThanOrEqual(608);
    }
  });

  it('draws the agent view as a tab beside a Claude Code tab', () => {
    const { getByRole } = renderView(<ScreenSection />);
    const map = within(getByRole('img', { name: MAP_NAME }));
    expect(map.getByText('Agent view')).toBeDefined();
    expect(map.getByText('Claude Code')).toBeDefined();
    expect(map.getByText('TOOL TIMELINE')).toBeDefined();
  });

  it('says where every piece is and how to get there', () => {
    const { getByRole } = renderView(<ScreenSection />);
    const table = getByRole('table', { name: 'Where each piece of Overlord is' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toStrictEqual(
      PIECES.map((piece) => `${String(piece.area)}${piece.name}${piece.what}${piece.open}`),
    );
  });

  it('only sends pieces to places Overlord already uses', () => {
    const used = new Set(
      SCREEN_AREAS.filter((area) => area.overlord !== null).map((area) => area.number),
    );
    expect(PIECES.filter((piece) => !used.has(piece.area))).toStrictEqual([]);
  });

  it('gives the flow diagrams only numbers the map has', () => {
    const { container } = renderView(<SessionsSection />);
    const numbers = new Set(SCREEN_AREAS.map((area) => String(area.number)));
    const badges = [...container.querySelectorAll('.flow-area')];
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(numbers.has(badge.textContent)).toBe(true);
    }
  });

  it('has no accessibility violations', async () => {
    const { container, getByRole } = renderView(<ScreenSection />);
    expect(getByRole('heading', { level: 2, name: 'Where things are' })).toBeDefined();
    await expectAccessible(container);
  });
});
