import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectAccessible, renderView } from '../../test/render.js';

import { ExtendSection } from './help-extend.js';
import { OFF_SCREEN, SCREEN_AREAS } from './help-screen-content.js';

describe('ExtendSection', () => {
  it('explains every area and says what Overlord puts there', () => {
    const { getByRole } = renderView(<ExtendSection />);
    const table = getByRole('table', { name: 'Places an extension can draw into' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toStrictEqual(
      SCREEN_AREAS.map(
        (area) => `${String(area.number)}${area.name}${area.apis}${area.overlord ?? 'Not yet.'}`,
      ),
    );
    expect(table.querySelectorAll('.ext-number-used')).toHaveLength(
      SCREEN_AREAS.filter((area) => area.overlord !== null).length,
    );
  });

  it('points at the screen map for the numbers', () => {
    const { getByRole } = renderView(<ExtendSection />);
    expect(getByRole('link', { name: 'Where things are' }).getAttribute('href')).toBe(
      '#help-screen',
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
