// Cell text is concatenated in assertions. cspell:ignore Usersession startnonenone Projectnested pdfplugin voiceuser platformdarwin Yesexcluded
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { ContextSnapshot } from '../../../src/shared/model.js';
import type { ContextState } from '../../../src/shared/protocol.js';
import { contextState, snapshot } from '../../test/fixtures-context.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { blockSummary } from './context-sections.js';
import { diskState, yesNo } from './context-tables.js';
import { ContextView } from './context-view.js';

const firstLoaded = snapshot.loaded[0];

const sparse: ContextSnapshot = {
  ...snapshot,
  model: null,
  systemPrompt: null,
  loaded: firstLoaded === undefined ? [] : [{ ...firstLoaded, differsFromDisk: null }],
  skipped: [],
  skills: [],
  agentTypes: [],
  mcpServers: [],
  deferredTools: [],
  environment: {},
  weights: [],
};

function table(name: string): HTMLElement {
  return screen.getByRole('table', { name });
}

function rowTexts(element: HTMLElement): (string | null)[] {
  return within(element)
    .getAllByRole('row')
    .map((row) => row.textContent);
}

async function clickEverySortHeader(element: HTMLElement): Promise<number> {
  const user = userEvent.setup();
  const headers = within(element).getAllByRole('columnheader');
  let clicked = 0;
  for (const header of headers) {
    const button = within(header).queryByRole('button');
    if (button !== null) {
      await user.click(button);
      clicked += 1;
    }
  }
  return clicked;
}

describe('ContextView', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderView(<ContextView state={contextState} />);
    expect(screen.getAllByRole('table').length).toBeGreaterThan(4);
    await expectAccessible(container);
  });

  it('picks a session and ignores the placeholder', async () => {
    const user = userEvent.setup();
    const { api } = renderView(<ContextView state={contextState} />);
    const picker = screen.getByRole('combobox', { name: 'Session' });
    expect(picker).toHaveProperty('value', 's1');
    await user.selectOptions(picker, 's2');
    await user.selectOptions(picker, '');
    expect(api.actions()).toStrictEqual([{ type: 'openContext', sessionId: 's2', agentId: null }]);
  });

  it('shows the model and system prompt blocks collapsed', () => {
    renderView(<ContextView state={contextState} />);
    expect(screen.getByText(/claude-opus-4-7, as of/u)).toBeDefined();
    const block = screen.getByText('Block 2: Use tools carefully.').closest('details');
    expect(block?.open).toBe(false);
    expect(block?.querySelector('pre')?.textContent).toBe('Use tools carefully.');
  });

  it('lists loaded memory files and opens one', async () => {
    const user = userEvent.setup();
    const { api } = renderView(<ContextView state={contextState} />);
    const loaded = table('Loaded memory files');
    expect(rowTexts(loaded)).toStrictEqual([
      'PathTierReasonTriggerImported byBytesDiffers from disk',
      '/Users/dev/.claude/CLAUDE.mdUsersession_startnonenone2,048No',
      '/Users/dev/repos/app/src/CLAUDE.mdProjectnested_traversal/Users/dev/repos/app/src/parser.ts/Users/dev/repos/app/CLAUDE.md512Yes',
    ]);
    await user.click(within(loaded).getByRole('button', { name: '/Users/dev/.claude/CLAUDE.md' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openFile', path: '/Users/dev/.claude/CLAUDE.md' },
    ]);
  });

  it('sorts every sortable table column', async () => {
    const extraSkip: ContextSnapshot['skipped'][number] = {
      path: '/Users/dev/repos/app/AGENTS.md',
      tier: 'Project',
      exists: false,
      code: 'agents-md-shadowed',
      detail: 'A CLAUDE.md exists in cwd.',
    };
    const state: ContextState = {
      ...contextState,
      snapshot: { ...snapshot, skipped: [...snapshot.skipped, extraSkip] },
    };
    renderView(<ContextView state={state} />);
    expect(await clickEverySortHeader(table('Loaded memory files'))).toBe(4);
    // The last click sorted by bytes ascending.
    expect(rowTexts(table('Loaded memory files'))[1]).toContain('512');
    expect(await clickEverySortHeader(table('Files that did not load'))).toBe(3);
    // Sorted by reason code: agents-md-shadowed before excluded.
    expect(rowTexts(table('Files that did not load'))[1]).toContain('AGENTS.mdProjectNo');
    expect(await clickEverySortHeader(table('Skills'))).toBe(3);
    expect(rowTexts(table('Skills')).slice(1)).toStrictEqual([
      'pdfpluginYesNo300',
      'writing-voiceuserYesYes420',
    ]);
    expect(await clickEverySortHeader(table('Environment'))).toBe(1);
    expect(rowTexts(table('Environment')).slice(1)).toStrictEqual([
      'cwd/Users/dev/repos/app',
      'platformdarwin',
    ]);
  });

  it('explains why files did not load', () => {
    renderView(<ContextView state={contextState} />);
    expect(rowTexts(table('Files that did not load'))[1]).toBe(
      '/Users/dev/repos/app/vendor/CLAUDE.mdProjectYesexcludedExcluded by claudeMdExcludes pattern in user settings.',
    );
  });

  it('shows agent types, MCP instructions, deferred tools and weights', () => {
    renderView(<ContextView state={contextState} />);
    const agents = screen.getByRole('list', { name: 'Agent types' });
    expect(
      within(agents)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toStrictEqual(['Explore', 'Plan']);
    const deferred = screen.getByRole('list', { name: 'Deferred tools' });
    expect(within(deferred).getAllByRole('listitem')).toHaveLength(2);
    const github = screen.getByText('github').closest('details');
    expect(github?.textContent).toContain('Use the GitHub tools for issues.');
    expect(screen.getByRole('img', { name: 'Token weight' }).querySelector('svg')).not.toBeNull();
    expect(rowTexts(table('Token weight')).slice(1)).toStrictEqual([
      'System prompt3,000No',
      'Memory files (est.)1,200Yes',
      'Empty0No',
    ]);
  });

  it('shows plain text for sparse snapshots', async () => {
    const state: ContextState = { ...contextState, snapshot: sparse };
    const { container } = renderView(<ContextView state={state} />);
    expect(screen.getByText(/unknown model, as of/u)).toBeDefined();
    expect(screen.getByText('Not captured for this session.')).toBeDefined();
    expect(rowTexts(table('Loaded memory files'))[1]).toContain('Unknown');
    expect(screen.getByText('Every candidate loaded.')).toBeDefined();
    expect(screen.getByText('No skills.')).toBeDefined();
    expect(screen.getAllByText('None.')).toHaveLength(2);
    expect(screen.getByText('No MCP server instructions.')).toBeDefined();
    expect(screen.getByText('No environment block.')).toBeDefined();
    expect(screen.queryByRole('img', { name: 'Token weight' })).toBeNull();
    await expectAccessible(container);
  });

  it('shows an empty state with no snapshot', async () => {
    const user = userEvent.setup();
    const { api, container } = renderView(
      <ContextView state={{ snapshot: null, sessions: contextState.sessions }} />,
    );
    expect(screen.getByRole('status').textContent).toContain('No context yet');
    const picker = screen.getByRole('combobox', { name: 'Session' });
    expect(picker).toHaveProperty('value', '');
    await user.selectOptions(picker, 's1');
    expect(api.actions()).toStrictEqual([{ type: 'openContext', sessionId: 's1', agentId: null }]);
    await expectAccessible(container);
  });
});

describe('context helpers', () => {
  it('summarizes a prompt block by its first non blank line', () => {
    expect(blockSummary('\n  hello there\nmore')).toBe('hello there');
    expect(blockSummary('')).toBe('(empty)');
    expect(blockSummary('   \n  ')).toBe('(empty)');
    expect(blockSummary('x'.repeat(100))).toHaveLength(80);
  });

  it('words booleans and disk state', () => {
    expect(yesNo(true)).toBe('Yes');
    expect(yesNo(false)).toBe('No');
    expect(diskState(null)).toStrictEqual({ label: 'Unknown', tone: 'neutral' });
    expect(diskState(true)).toStrictEqual({ label: 'Yes', tone: 'warning' });
    expect(diskState(false)).toStrictEqual({ label: 'No', tone: 'good' });
  });
});
