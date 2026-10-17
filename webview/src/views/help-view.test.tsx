import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectAccessible, renderView } from '../../test/render.js';
import { PLACE_INFO, STATE_INFO, WINDOWLESS_INFO } from '../labels.js';

import { STATUS_INFO } from './config-labels.js';
import { SIDEBAR_GROUPS, WORKFLOW } from './help-content.js';
import { ROW_BUTTONS } from './help-row-buttons.js';
import { HelpView } from './help-view.js';

describe('HelpView', () => {
  it('walks through the workflow in order', () => {
    const { getByRole } = renderView(<HelpView />);
    const steps = within(getByRole('region', { name: 'A typical workflow' })).getAllByRole(
      'listitem',
    );
    expect(steps.map((step) => step.querySelector('strong')?.textContent)).toStrictEqual(
      WORKFLOW.map((step) => `${step.title}.`),
    );
  });

  it('explains every sidebar entry', () => {
    const { getByRole } = renderView(<HelpView />);
    for (const group of SIDEBAR_GROUPS) {
      const table = getByRole('table', { name: `${group.title} entries` });
      expect(within(table).getAllByRole('row')).toHaveLength(group.entries.length + 1);
    }
  });

  it('shows every state, place and config badge with its meaning', () => {
    const { getByRole } = renderView(<HelpView />);
    const states = getByRole('table', { name: 'Session states' });
    for (const info of Object.values(STATE_INFO)) {
      expect(within(states).getByText(info.description)).toBeDefined();
    }
    const places = getByRole('table', { name: 'Where a session runs' });
    for (const info of Object.values(PLACE_INFO)) {
      expect(within(places).getByRole('img', { name: info.label })).toBeDefined();
    }
    expect(within(places).getByRole('img', { name: WINDOWLESS_INFO.label })).toBeDefined();
    const config = getByRole('table', { name: 'Config badges' });
    for (const info of Object.values(STATUS_INFO)) {
      expect(within(config).getByText(info.meaning)).toBeDefined();
    }
  });

  it('draws the real row button icons', () => {
    const { getByRole } = renderView(<HelpView />);
    const table = getByRole('table', { name: 'Fleet row buttons' });
    expect(table.querySelectorAll('svg.icon')).toHaveLength(ROW_BUTTONS.length);
    expect(within(table).getByText('Interrupt')).toBeDefined();
  });

  it('cuts the page and its contents down to what a search finds', () => {
    const { getByRole, queryByRole } = renderView(<HelpView />);
    const contents = getByRole('navigation', { name: 'On this page' });
    const allLinks = within(contents).getAllByRole('link').length;
    fireEvent.change(getByRole('searchbox', { name: 'Search help' }), {
      target: { value: 'config badges' },
    });
    expect(getByRole('region', { name: 'Config badges' })).toBeDefined();
    expect(queryByRole('region', { name: 'Session states' })).toBeNull();
    expect(within(contents).getAllByRole('link').length).toBeLessThan(allLinks);
    expect(within(contents).getByRole('link', { name: 'Config badges' })).toBeDefined();
  });

  it('says so when nothing matches, and Cmd+F jumps to the box', () => {
    const { getByRole } = renderView(<HelpView />);
    const box = getByRole('searchbox', { name: 'Search help' });
    fireEvent.keyDown(document, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'pineapple' } });
    expect(getByRole('status').textContent).toBe('Nothing in help matches "pineapple".');
  });

  // The page is long and full of diagrams, so axe takes several seconds on a busy machine.
  it('has no accessibility violations', { timeout: 30_000 }, async () => {
    const { container, getByRole } = renderView(<HelpView />);
    expect(getByRole('heading', { level: 1, name: 'Overlord help' })).toBeDefined();
    await expectAccessible(container);
  });
});
