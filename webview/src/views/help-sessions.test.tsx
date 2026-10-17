import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectAccessible, renderView } from '../../test/render.js';

import { SessionsSection } from './help-sessions.js';

const DIAGRAMS = [
  'Ways a session starts',
  'A new session, step by step',
  'The tab and the session',
  'Closing the tab',
];

describe('SessionsSection', () => {
  it('draws one diagram per part of a session', () => {
    const { getByRole } = renderView(<SessionsSection />);
    const section = getByRole('region', { name: 'How a Claude Code session works' });
    const names = within(section)
      .getAllByRole('img')
      .map((svg) => svg.querySelector('title')?.textContent);
    expect(names).toStrictEqual(DIAGRAMS);
  });

  it('points every arrow at the arrowhead of its own diagram', () => {
    const { container } = renderView(<SessionsSection />);
    for (const svg of container.querySelectorAll('svg.flow')) {
      const head = svg.querySelector('marker')?.id;
      const arrows = [...svg.querySelectorAll('path.flow-arrow')];
      expect(arrows.length).toBeGreaterThan(0);
      for (const arrow of arrows) {
        expect(arrow.getAttribute('marker-end')).toBe(`url(#${String(head)})`);
      }
    }
  });

  it('draws commands in the code font without the backtick', () => {
    const { container } = renderView(<SessionsSection />);
    const commands = [...container.querySelectorAll('text.flow-code')].map(
      (text) => text.textContent,
    );
    expect(commands).toContain('claude --bg');
    expect(commands).toContain('claude attach <id>');
    expect(container.textContent).not.toContain('`');
  });

  it('says that closing the tab stops only an idle session', () => {
    const { getByRole } = renderView(<SessionsSection />);
    const diagram = getByRole('img', { name: /A session mid turn keeps working/u });
    expect(within(diagram).getByText('It was mid turn')).toBeDefined();
    expect(within(diagram).getByText('Overlord runs claude stop.')).toBeDefined();
    expect(within(diagram).getByText('Not landed')).toBeDefined();
  });

  it('has no accessibility violations', async () => {
    const { container, getByRole } = renderView(<SessionsSection />);
    expect(
      getByRole('heading', { level: 2, name: 'How a Claude Code session works' }),
    ).toBeDefined();
    await expectAccessible(container);
  });
});
