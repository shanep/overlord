import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RegistryServer, RegistryState } from '../../../src/shared/connectors.js';
import { EMPTY_REGISTRY } from '../../../src/shared/connectors.js';
import { expectAccessible, renderView } from '../../test/render.js';

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

function found(overrides: Partial<RegistryState> = {}): RegistryState {
  return { ...EMPTY_REGISTRY, query: 'sentry', results: [SENTRY, BUNDLE], ...overrides };
}

describe('RegistrySection', () => {
  it('searches by name and shows nothing until it has', () => {
    const { getByRole, queryByRole, api } = renderView(
      <RegistrySection registry={EMPTY_REGISTRY} />,
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
      <RegistrySection registry={found({ more: true })} />,
    );
    expect(container.textContent).toContain('Not installable from here');
    expect(container.textContent).toContain('There are more matches.');
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
      <RegistrySection registry={found()} />,
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
        registry={found({ results: [], error: 'Could not search the MCP registry: offline' })}
      />,
    );
    expect(failed.getByRole('alert').textContent).toBe(
      'Could not search the MCP registry: offline',
    );
    failed.unmount();
    const empty = renderView(<RegistrySection registry={found({ results: [] })} />);
    expect(empty.container.textContent).toContain('No servers match that name.');
    empty.unmount();
    const searching = renderView(
      <RegistrySection registry={found({ results: [], searching: true })} />,
    );
    expect(searching.getByRole('button', { name: 'Searching…' })).toHaveProperty('disabled', true);
    searching.unmount();
    const refused = renderView(
      <RegistrySection registry={found({ notice: { ok: false, text: 'Fill in X first.' } })} />,
    );
    expect(refused.getByRole('alert').textContent).toContain('Not added');
  });
});
