import { fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { CatalogEntry, CatalogState, LibraryState } from '../../../src/shared/catalog.js';
import type { ConfigItem } from '../../../src/shared/model.js';
import { expectAccessible, first, renderView } from '../../test/render.js';

import { filterEntries, PAGE_SIZE } from './library-catalog.js';
import { LibraryView } from './library-view.js';

const MINE: ConfigItem = {
  id: 'skill:pdf',
  kind: 'skill',
  name: 'pdf',
  scope: 'user',
  path: '/home/dev/.claude/skills/pdf',
  realPath: '/home/dev/.overlord-config/skills/pdf',
  status: 'versioned',
  repo: null,
};

function entry(name: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: `anthropics/skills:skills/${name}/SKILL.md`,
    name,
    description: `Does ${name} things.`,
    repo: 'anthropics/skills',
    group: '',
    installs: null,
    url: `https://github.com/anthropics/skills/tree/HEAD/skills/${name}`,
    ...overrides,
  };
}

const SOURCES: CatalogState['sources'] = [
  {
    id: 'anthropics/skills',
    label: 'Anthropic',
    description: "Anthropic's own skills.",
    url: 'https://github.com/anthropics/skills',
    search: false,
  },
  {
    id: 'skills.sh',
    label: 'Search skills.sh',
    description: 'The open skills directory.',
    url: 'https://skills.sh',
    search: true,
  },
];

function state(
  catalog: Partial<CatalogState> = {},
  installed: readonly ConfigItem[] = [MINE],
): LibraryState {
  return {
    kind: 'skill',
    installed,
    catalog: {
      sources: SOURCES,
      source: 'anthropics/skills',
      query: null,
      loading: false,
      entries: [entry('pdf'), entry('xlsx', { group: 'documents' })],
      error: null,
      installing: null,
      notice: null,
      ...catalog,
    },
  };
}

describe('LibraryView', () => {
  it('shows installed skills and premade ones, marking what is installed', async () => {
    const { getByRole, getByText, container } = renderView(<LibraryView state={state()} />);
    expect(getByRole('heading', { name: 'Skills' })).toBeDefined();
    const user = getByRole('list', { name: /^For every project/u });
    expect(within(user).getByText('Links to /home/dev/.overlord-config/skills/pdf')).toBeDefined();
    const list = getByRole('list', { name: 'Premade skills' });
    expect(within(list).getByRole('button', { name: 'Install pdf' }).textContent).toBe(
      'Install again',
    );
    expect(within(list).getByRole('button', { name: 'Install xlsx' }).textContent).toBe('Install');
    expect(within(list).getByText('documents')).toBeDefined();
    expect(getByText('2 of 2 skills')).toBeDefined();
    await expectAccessible(container);
  });

  it('posts new, open, browse, read and install actions', async () => {
    const { getByRole, api } = renderView(<LibraryView state={state()} />);
    await userEvent.click(getByRole('button', { name: 'New skill' }));
    await userEvent.click(getByRole('button', { name: 'Open pdf' }));
    await userEvent.click(getByRole('button', { name: 'Search skills.sh' }));
    await userEvent.click(getByRole('button', { name: 'Open anthropics/skills' }));
    await userEvent.click(
      first(
        within(getByRole('list', { name: 'Premade skills' })).getAllByRole('button', {
          name: 'Read it',
        }),
      ),
    );
    await userEvent.click(getByRole('button', { name: 'Install xlsx' }));
    expect(api.actions()).toStrictEqual([
      { type: 'newSkill' },
      { type: 'openFile', path: '/home/dev/.claude/skills/pdf' },
      { type: 'browseCatalog', kind: 'skill', source: 'skills.sh' },
      { type: 'openCatalogLink', kind: 'skill', url: 'https://github.com/anthropics/skills' },
      {
        type: 'openCatalogLink',
        kind: 'skill',
        url: 'https://github.com/anthropics/skills/tree/HEAD/skills/pdf',
      },
      { type: 'installCatalog', kind: 'skill', entryId: 'anthropics/skills:skills/xlsx/SKILL.md' },
    ]);
  });

  it('filters a collection and shows it a page at a time', () => {
    const many = Array.from({ length: PAGE_SIZE + 5 }, (_, index) =>
      entry(`skill-${String(index)}`),
    );
    const { getByRole, getByText, queryByRole } = renderView(
      <LibraryView state={state({ entries: many }, [])} />,
    );
    expect(
      within(getByRole('list', { name: 'Premade skills' })).getAllByRole('listitem'),
    ).toHaveLength(PAGE_SIZE);
    fireEvent.click(getByRole('button', { name: 'Show more' }));
    expect(
      within(getByRole('list', { name: 'Premade skills' })).getAllByRole('listitem'),
    ).toHaveLength(PAGE_SIZE + 5);
    expect(queryByRole('button', { name: 'Show more' })).toBeNull();
    fireEvent.change(getByRole('searchbox', { name: 'Filter' }), { target: { value: 'skill-12' } });
    expect(getByText(`1 of ${String(PAGE_SIZE + 5)} skills`)).toBeDefined();
    expect(getByText('No skills yet. Make one or install one below.')).toBeDefined();
  });

  it('searches skills.sh and shows install counts', async () => {
    const hit = entry('react', { id: 'skills.sh:a/b/react', description: '', installs: 12_345 });
    const { getByRole, getByText, api } = renderView(
      <LibraryView state={state({ source: 'skills.sh', query: 'react', entries: [hit] })} />,
    );
    expect(getByText('12,345 installs')).toBeDefined();
    expect(getByText('1 skills for "react"')).toBeDefined();
    const box = getByRole('searchbox', { name: 'Skill name or topic' });
    await userEvent.clear(box);
    await userEvent.type(box, 'pdf{Enter}');
    expect(api.actions()).toStrictEqual([{ type: 'searchCatalog', kind: 'skill', query: 'pdf' }]);
  });

  it('shows loading, an empty search, errors and how the last install went', () => {
    const { getByText, rerender, queryByRole } = renderView(
      <LibraryView state={state({ loading: true, entries: [] })} />,
    );
    expect(getByText('Loading the skills from anthropics/skills…')).toBeDefined();
    rerender(<LibraryView state={state({ source: 'skills.sh', entries: [] })} />);
    expect(queryByRole('list', { name: 'Premade skills' })).toBeNull();
    rerender(
      <LibraryView
        state={state({ source: 'skills.sh', loading: true, query: 'x', entries: [] })}
      />,
    );
    expect(getByText('Searching…', { selector: 'p' })).toBeDefined();
    rerender(<LibraryView state={state({ entries: [] })} />);
    expect(getByText('Nothing found.')).toBeDefined();
    rerender(
      <LibraryView
        state={state({
          entries: [],
          error: 'GitHub said no.',
          installing: 'x',
          notice: { ok: false, text: 'It broke.' },
        })}
      />,
    );
    expect(getByText('GitHub said no.')).toBeDefined();
    expect(getByText('It broke.')).toBeDefined();
    expect(queryByRole('status')).toBeNull();
    rerender(
      <LibraryView
        state={state({ installing: entry('pdf').id, notice: { ok: true, text: 'Done.' } })}
      />,
    );
    expect(getByText('Done.')).toBeDefined();
    expect(getByText('Installing…')).toBeDefined();
  });

  it('names agents as agents', () => {
    const { getByRole, getByText } = renderView(
      <LibraryView state={{ ...state({}, []), kind: 'agent' }} />,
    );
    expect(getByRole('heading', { name: 'Agents' })).toBeDefined();
    expect(getByRole('button', { name: 'New agent' })).toBeDefined();
    expect(getByText('No agents yet. Make one or install one below.')).toBeDefined();
  });
});

describe('filterEntries', () => {
  it('matches every word against name, group and description', () => {
    const entries = [entry('pdf'), entry('xlsx', { group: 'documents' })];
    expect(filterEntries(entries, '  ')).toBe(entries);
    expect(filterEntries(entries, 'DOCUMENTS xlsx').map((found) => found.name)).toStrictEqual([
      'xlsx',
    ]);
    expect(filterEntries(entries, 'pdf nope')).toStrictEqual([]);
  });
});
