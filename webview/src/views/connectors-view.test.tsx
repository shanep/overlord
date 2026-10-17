import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Connector, ConnectorsState } from '../../../src/shared/connectors.js';
import { EMPTY_REGISTRY } from '../../../src/shared/connectors.js';
import { codexAgent } from '../../test/fixtures-agents.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';
import { CLAUDE_FALLBACK } from '../claude-fallback.js';

import { ConnectorsView, KIND_LABELS, STATUS_INFO } from './connectors-view.js';

function connector(overrides: Partial<Connector> & Pick<Connector, 'id' | 'name'>): Connector {
  return {
    kind: 'mcp',
    target: '',
    status: 'ok',
    detail: 'Connected.',
    fix: null,
    ...overrides,
  };
}

/** The names on the cards in one group, in the order they show. */
function names(list: HTMLElement): (string | null)[] {
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.querySelector('.card-title')?.textContent ?? null);
}

const STATE: ConnectorsState = {
  checkedAt: NOW - 2 * 60_000,
  checking: false,
  folder: '/work/repo',
  mcpAgents: ['claude-code'],
  registry: EMPTY_REGISTRY,
  connectors: [
    connector({
      id: 'claude.ai:claude.ai Gmail',
      name: 'claude.ai Gmail',
      kind: 'claude.ai',
      target: 'https://gmail',
    }),
    connector({
      id: 'chrome:claude-in-chrome',
      name: 'Claude in Chrome',
      kind: 'chrome',
      status: 'missing',
      detail: 'No Chrome is connected.',
      fix: 'open-chrome',
    }),
    connector({
      id: 'mcp:sentry',
      name: 'sentry',
      status: 'needs-auth',
      detail: 'Needs a sign in.',
      fix: 'sign-in',
    }),
  ],
};

describe('ConnectorsView', () => {
  it('groups problems first with their fix buttons, and passes axe', async () => {
    const { container, getByRole, api } = renderView(<ConnectorsView state={STATE} />);
    const attention = getByRole('list', { name: 'Needs attention 2' });
    const ready = getByRole('list', { name: 'Ready 1' });
    expect(names(attention)).toStrictEqual(['Claude in Chrome', 'sentry']);
    expect(names(ready)).toStrictEqual(['Gmail']);
    expect(ready.querySelector('.card-title')?.getAttribute('title')).toBe('https://gmail');
    expect(attention.querySelector('.card-title')?.hasAttribute('title')).toBe(false);
    expect(ready.textContent).toContain('claude.ai connector');
    expect(ready.querySelector('.badge')).toBeNull();
    expect(attention.textContent).toContain('Needs sign in');
    expect(attention.querySelector('.card')?.className).toBe('card card-edge card-critical');
    expect(getByRole('heading', { level: 1 }).textContent).toBe('Connectors (MCP)');
    expect(container.textContent).toContain('from /work/repo');
    expect(container.textContent).toContain('Last checked');
    fireEvent.click(getByRole('button', { name: 'Open Chrome' }));
    fireEvent.click(getByRole('button', { name: 'Sign in' }));
    fireEvent.click(getByRole('button', { name: 'Recheck' }));
    expect(api.actions()).toStrictEqual([
      { type: 'fixConnector', connectorId: 'chrome:claude-in-chrome' },
      { type: 'fixConnector', connectorId: 'mcp:sentry' },
      { type: 'recheckConnectors' },
    ]);
    const stats = container.querySelectorAll('.stat dd');
    expect([...stats].map((item) => item.textContent)).toStrictEqual(['1', '2']);
    await expectAccessible(container);
  });

  it('shows a check in progress and a view that has not checked yet', () => {
    const checking = renderView(
      <ConnectorsView
        state={{
          connectors: [],
          checkedAt: null,
          checking: true,
          folder: null,
          mcpAgents: ['claude-code'],
          registry: EMPTY_REGISTRY,
        }}
      />,
    );
    expect(checking.container.textContent).toContain('Checking every connector.');
    expect(checking.container.textContent).toContain('Checking…');
    expect(checking.getByRole('button', { name: 'Recheck' })).toHaveProperty('disabled', true);
    expect(checking.container.textContent).not.toContain('sees them from');
    checking.unmount();
    const fresh = renderView(
      <ConnectorsView
        state={{
          connectors: [],
          checkedAt: null,
          checking: false,
          folder: null,
          mcpAgents: ['claude-code'],
          registry: EMPTY_REGISTRY,
        }}
      />,
    );
    expect(fresh.container.textContent).toContain('Not checked yet.');
    expect(fresh.container.textContent).toContain('No connectors found.');
  });

  it('names the agent on each card and keeps unchecked servers apart once Codex has rows', async () => {
    const state: ConnectorsState = {
      ...STATE,
      connectors: [
        ...STATE.connectors,
        connector({
          id: 'codex/mcp:docs',
          name: 'docs',
          status: 'unchecked',
          detail: 'Set up in /h/.codex/config.toml.',
          agent: 'codex',
        }),
      ],
    };
    const { container, getByRole } = renderView(<ConnectorsView state={state} />, undefined, [
      CLAUDE_FALLBACK,
      codexAgent,
    ]);
    const unchecked = getByRole('list', { name: 'Set up, not checked 1' });
    expect(names(unchecked)).toStrictEqual(['docs']);
    expect(unchecked.textContent).toContain('MCP server · Codex');
    expect(unchecked.textContent).toContain('Not checked');
    expect(getByRole('list', { name: 'Ready 1' }).textContent).toContain(
      'claude.ai connector · Claude',
    );
    expect(getByRole('list', { name: 'Needs attention 2' }).textContent).toContain(
      'Browser · Claude',
    );
    expect(container.textContent).toContain('Codex servers come from their own config files');
    await expectAccessible(container);
  });

  it('has a label for every status and kind', () => {
    expect(Object.keys(STATUS_INFO)).toHaveLength(8);
    expect(KIND_LABELS.headless).toBe('Browser');
    expect(KIND_LABELS.mcp).toBe('MCP server');
  });
});
