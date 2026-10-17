import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RegistryServer, RegistryState } from '../../../src/shared/connectors.js';
import { EMPTY_REGISTRY } from '../../../src/shared/connectors.js';
import { codexAgent } from '../../test/fixtures-agents.js';
import { expectAccessible, renderView } from '../../test/render.js';
import { CLAUDE_FALLBACK } from '../claude-fallback.js';

import { RegistrySection } from './connectors-registry.js';

const SENTRY: RegistryServer = {
  name: 'io.github.getsentry/sentry-mcp',
  title: 'Sentry',
  description: 'Errors and traces.',
  version: '1.2.0',
  repository: 'https://github.com/getsentry/sentry-mcp',
  suggestedName: 'sentry',
  options: [
    { kind: 'http', summary: 'https://mcp.sentry.dev/mcp', inputs: [] },
    {
      kind: 'npm',
      summary: 'npx -y @sentry/mcp-server@1.2.0',
      inputs: [
        {
          id: 'env:SENTRY_TOKEN',
          label: 'SENTRY_TOKEN',
          description: 'Auth token',
          required: true,
          secret: true,
          initial: '',
          placeholder: '',
        },
        {
          id: 'env:SENTRY_HOST',
          label: 'SENTRY_HOST',
          description: '',
          required: false,
          secret: false,
          initial: 'sentry.io',
          placeholder: '',
        },
      ],
    },
  ],
};

const BUNDLE: RegistryServer = {
  ...SENTRY,
  name: 'io.github.x/bundle',
  title: 'Bundle',
  description: '',
  version: '',
  repository: null,
  options: [],
};

const CLAUDE_ONLY = ['claude-code'];

function found(overrides: Partial<RegistryState> = {}): RegistryState {
  return { ...EMPTY_REGISTRY, query: 'sentry', results: [SENTRY, BUNDLE], ...overrides };
}

describe('RegistrySection', () => {
  it('searches by name and shows nothing until it has', () => {
    const { getByRole, queryByRole, api } = renderView(
      <RegistrySection mcpAgents={CLAUDE_ONLY} registry={EMPTY_REGISTRY} />,
    );
    expect(queryByRole('list', { name: 'Registry results' })).toBeNull();
    fireEvent.change(getByRole('searchbox', { name: 'Server name' }), {
      target: { value: 'sentry' },
    });
    fireEvent.click(getByRole('button', { name: 'Search' }));
    expect(api.actions()).toStrictEqual([{ type: 'searchRegistry', query: 'sentry' }]);
  });

  it('installs the option picked with what was typed, and passes axe', async () => {
    const { container, getByRole, getByLabelText, api } = renderView(
      <RegistrySection mcpAgents={CLAUDE_ONLY} registry={found({ more: true })} />,
    );
    expect(container.textContent).toContain('Not installable from here');
    expect(container.textContent).toContain('2 servers whose name has "sentry" so far');
    fireEvent.click(getByRole('button', { name: 'Install…' }));
    expect(getByRole('combobox', { name: 'Install as' })).toBeDefined();
    fireEvent.change(getByRole('combobox', { name: 'Install as' }), { target: { value: '1' } });
    const install = getByRole('button', { name: 'Install' });
    expect(install).toHaveProperty('disabled', true);
    expect(container.textContent).toContain('Fill in SENTRY_TOKEN.');
    const token = getByLabelText('SENTRY_TOKEN (required)');
    expect(token.getAttribute('type')).toBe('password');
    fireEvent.change(token, { target: { value: 'tok' } });
    fireEvent.change(getByLabelText('Name in Claude Code'), { target: { value: 'my-sentry' } });
    expect(install).toHaveProperty('disabled', false);
    await expectAccessible(container);
    fireEvent.click(install);
    expect(api.actions()).toStrictEqual([
      {
        type: 'installConnector',
        server: 'io.github.getsentry/sentry-mcp',
        option: 1,
        name: 'my-sentry',
        values: { 'env:SENTRY_TOKEN': 'tok', 'env:SENTRY_HOST': 'sentry.io' },
      },
    ]);
  });

  it('will not install under a name Claude Code rejects, and closes on Cancel', () => {
    const { getByRole, getByLabelText, queryByRole } = renderView(
      <RegistrySection mcpAgents={CLAUDE_ONLY} registry={found()} />,
    );
    fireEvent.click(getByRole('button', { name: 'Install…' }));
    fireEvent.change(getByLabelText('Name in Claude Code'), { target: { value: 'has space' } });
    expect(getByRole('alert').textContent).toBe(
      'Use only letters, digits, dashes and underscores.',
    );
    expect(getByRole('button', { name: 'Install' })).toHaveProperty('disabled', true);
    fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(queryByRole('form')).toBeNull();
  });

  it('shows an install in progress, how it went, errors and empty results', () => {
    const view = renderView(
      <RegistrySection
        mcpAgents={CLAUDE_ONLY}
        registry={found({
          installing: SENTRY.name,
          notice: { ok: true, text: 'Added sentry for every project.' },
        })}
      />,
    );
    expect(view.getByRole('status').textContent).toContain('Added sentry for every project.');
    expect(view.getByRole('button', { name: 'Install…' })).toHaveProperty('disabled', true);
    view.unmount();
    const failed = renderView(
      <RegistrySection
        mcpAgents={CLAUDE_ONLY}
        registry={found({ results: [], error: 'Could not search the MCP registry: offline' })}
      />,
    );
    expect(failed.getByRole('alert').textContent).toBe(
      'Could not search the MCP registry: offline',
    );
    failed.unmount();
    const empty = renderView(
      <RegistrySection mcpAgents={CLAUDE_ONLY} registry={found({ results: [] })} />,
    );
    expect(empty.container.textContent).toContain('No servers match that name.');
    empty.unmount();
    const searching = renderView(
      <RegistrySection
        mcpAgents={CLAUDE_ONLY}
        registry={found({ results: [], searching: true })}
      />,
    );
    expect(searching.getByRole('button', { name: 'Searching…' })).toHaveProperty('disabled', true);
    searching.unmount();
    const refused = renderView(
      <RegistrySection
        mcpAgents={CLAUDE_ONLY}
        registry={found({ notice: { ok: false, text: 'Fill in X first.' } })}
      />,
    );
    expect(refused.getByRole('alert').textContent).toContain('Not added');
  });

  it('browses everything, pages, filters by how a server runs and opens its repository', () => {
    const { getByRole, getAllByRole, container, api } = renderView(
      <RegistrySection mcpAgents={CLAUDE_ONLY} registry={found({ query: '', more: true })} />,
    );
    expect(container.textContent).toContain('2 servers from the registry so far');
    fireEvent.click(getByRole('button', { name: 'Browse all' }));
    fireEvent.click(getByRole('button', { name: 'Show more' }));
    fireEvent.click(getAllByRole('button', { name: 'Repository' })[0] ?? container);
    expect(api.actions()).toStrictEqual([
      { type: 'searchRegistry', query: '' },
      { type: 'moreRegistry' },
      { type: 'openRegistryLink', url: 'https://github.com/getsentry/sentry-mcp' },
    ]);
    expect(getAllByRole('button', { name: 'Repository' })).toHaveLength(1);
    fireEvent.click(getByRole('button', { name: 'Docker' }));
    expect(getByRole('button', { name: 'Docker' }).getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('2 servers from the registry so far, 0 shown');
    expect(container.textContent).toContain('None of these run that way.');
    fireEvent.click(getByRole('button', { name: 'Remote' }));
    expect(getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(getByRole('button', { name: 'npm' }));
    expect(getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(getByRole('button', { name: 'All' }));
    expect(getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the results when a page fails to load, and says so', () => {
    const { getByRole, getAllByRole } = renderView(
      <RegistrySection
        mcpAgents={CLAUDE_ONLY}
        registry={found({ loadingMore: true, more: true, error: 'Could not load more: offline' })}
      />,
    );
    expect(getAllByRole('listitem')).toHaveLength(2);
    expect(getByRole('alert').textContent).toBe('Could not load more: offline');
    expect(getByRole('button', { name: 'Loading…' })).toHaveProperty('disabled', true);
  });

  it('asks which agent to add to once another one has an MCP store', async () => {
    const { container, getByRole, getByLabelText, queryByRole, api } = renderView(
      <RegistrySection mcpAgents={['claude-code', 'codex']} registry={found()} />,
      undefined,
      [CLAUDE_FALLBACK, codexAgent],
    );
    expect(container.textContent).toContain('the mcp add command of the agent you pick.');
    fireEvent.click(getByRole('button', { name: 'Install…' }));
    const pick = getByRole('combobox', { name: 'Add to' });
    expect(getByLabelText('Name in Claude Code')).toBeDefined();
    fireEvent.change(pick, { target: { value: 'codex' } });
    expect(getByLabelText('Name in Codex CLI')).toBeDefined();
    await expectAccessible(container);
    fireEvent.click(getByRole('button', { name: 'Install' }));
    expect(api.actions()).toStrictEqual([
      {
        type: 'installConnector',
        server: 'io.github.getsentry/sentry-mcp',
        option: 0,
        name: 'sentry',
        values: {},
        agent: 'codex',
      },
    ]);
    fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(queryByRole('combobox', { name: 'Add to' })).toBeNull();
  });
});
