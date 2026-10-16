import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectAccessible, renderView } from '../../test/render.js';

import { OFF_SCREEN, SCREEN_AREAS } from './help-content.js';
import { ExtendSection } from './help-extend.js';

describe('ExtendSection', () => {
  it('puts one marker on the diagram for every area, solid where Overlord draws', () => {
    const { getByRole } = renderView(<ExtendSection />);
    const diagram = getByRole('img', { name: /Places in VS Code an extension can draw into/u });
    const markers = [...diagram.querySelectorAll('.ext-marker')];
    expect(markers.map((marker) => marker.textContent)).toStrictEqual(
      SCREEN_AREAS.map((area) => String(area.number)),
    );
    expect(diagram.querySelectorAll('.ext-marker-used')).toHaveLength(
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

  it('explains every area and says what Overlord puts there', () => {
    const { getByRole } = renderView(<ExtendSection />);
    const table = getByRole('table', { name: 'Places an extension can draw into' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toStrictEqual(
      SCREEN_AREAS.map(
        (area) => `${String(area.number)}${area.name}${area.apis}${area.overlord ?? 'Not yet.'}`,
      ),
    );
  });

  it('lists the extension points that have no place on the screen', () => {
    const { getByRole } = renderView(<ExtendSection />);
    const table = getByRole('table', { name: 'Extension points off the screen' });
    expect(within(table).getAllByRole('row')).toHaveLength(OFF_SCREEN.length + 1);
    expect(within(table).getAllByText('Not yet.').length).toBeGreaterThan(0);
  });

  it('has no accessibility violations', async () => {
    const { container, getByRole } = renderView(<ExtendSection />);
    expect(getByRole('heading', { level: 2, name: 'Extending Overlord' })).toBeDefined();
    await expectAccessible(container);
  });
});
