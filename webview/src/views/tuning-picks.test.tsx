import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CatalogPicks } from '../../../src/shared/tuning.js';
import { EMPTY_PICKS } from '../../../src/shared/tuning.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { PickList } from './tuning-picks.js';

const PICKS: CatalogPicks = {
  ...EMPTY_PICKS,
  topics: ['Python', 'LaTeX'],
  picks: [
    {
      id: 'skills.sh:c/d/pytest-pro',
      kind: 'skill',
      name: 'pytest-pro',
      description: '',
      repo: 'c/d',
      url: 'https://skills.sh/c/d/pytest-pro',
      installs: 1200,
      topic: 'Python',
      reason: '30 pytest commands in 3 sessions.',
    },
    {
      id: 'VoltAgent/x:python-pro.md',
      kind: 'agent',
      name: 'python-pro',
      description: 'Python expert',
      repo: 'VoltAgent/x',
      url: 'https://github.com/VoltAgent/x/blob/HEAD/python-pro.md',
      installs: null,
      topic: 'Python',
      reason: '30 pytest commands in 3 sessions.',
    },
  ],
};

describe('PickList', () => {
  it('shows each pick with why it fits, and posts open and install, and passes axe', async () => {
    const { getByRole, container, api } = renderView(<PickList picks={PICKS} />);
    const list = getByRole('list', { name: /From the Skills and Agents catalogs/u });
    const [skill, agent] = within(list).getAllByRole('listitem');
    expect(skill?.textContent).toContain('1,200 installs');
    expect(skill?.textContent).toContain('For your Python work: 30 pytest commands in 3 sessions.');
    expect(agent?.textContent).toContain('Python expert');
    expect(agent?.textContent).toContain('Agent');
    fireEvent.click(within(agent ?? container).getByRole('button', { name: 'Read it' }));
    fireEvent.click(getByRole('button', { name: 'Install python-pro' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openPickLink', pickId: 'VoltAgent/x:python-pro.md' },
      { type: 'installPick', pickId: 'VoltAgent/x:python-pro.md' },
    ]);
    await expectAccessible(container);
  });

  it('says what it is doing or why there is nothing, and shows how an install went', async () => {
    const { getByText, rerender, getByRole, container } = renderView(
      <PickList picks={EMPTY_PICKS} />,
    );
    expect(getByText(/No language or tool stands out/u)).toBeDefined();
    rerender(<PickList picks={{ ...EMPTY_PICKS, topics: ['Python'], loading: true }} />);
    expect(getByText('Searching the catalogs for Python…')).toBeDefined();
    rerender(<PickList picks={{ ...EMPTY_PICKS, topics: ['Python'] }} />);
    expect(getByText('Nothing new in the catalogs for Python.')).toBeDefined();
    rerender(
      <PickList
        picks={{
          ...PICKS,
          installing: 'VoltAgent/x:python-pro.md',
          error: 'Some catalogs could not be searched.',
          notice: { ok: false, text: 'It broke.' },
        }}
      />,
    );
    expect(getByText('Some catalogs could not be searched.')).toBeDefined();
    expect(getByRole('alert').textContent).toBe('It broke.');
    expect(getByRole('button', { name: 'Install python-pro' }).textContent).toBe('Installing…');
    expect(getByRole('button', { name: 'Install pytest-pro' })).toHaveProperty('disabled', true);
    await expectAccessible(container);
  });
});
