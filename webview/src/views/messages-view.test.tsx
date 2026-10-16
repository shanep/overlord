// Row text is concatenated cell text. cspell:ignore maina auditsent finishedsent mainsession Readysent unknownapi mergedblocked workermain
// Synthetic messages only.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  AgentMessage,
  AutoApproveRule,
  MessageRoute,
  MessagesState,
} from '../../../src/shared/protocol.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { inboundHelp } from './messages-inbound.js';
import type { LogFilter } from './messages-log.js';
import { filterMessages, toKindFilter } from './messages-log.js';
import { newBlockRule } from './messages-rules.js';
import { graphTitle, MessagesView, routeTable } from './messages-view.js';

const AGENT = 'a0123456789abcdef';

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'id'>): AgentMessage {
  return {
    at: NOW - 60_000,
    sessionId: 's1',
    from: 'main',
    to: AGENT,
    kind: 'send',
    preview: 'Start the audit',
    blocked: false,
    ...overrides,
  };
}

const messages: readonly AgentMessage[] = [
  message({ id: 'm1' }),
  message({
    id: 'm2',
    from: AGENT,
    to: 'main',
    kind: 'hand-back',
    preview: 'Audit finished',
  }),
  message({
    id: 'm3',
    to: 'uds:/tmp/cc-socks/77.sock',
    preview: 'Your branch is merged',
    blocked: true,
  }),
  message({ id: 'm4', from: 'api-worker', to: 'main', kind: 'receive', at: 0, preview: 'Ready' }),
];

const routes: readonly MessageRoute[] = [
  { from: 'main', to: AGENT, count: 3, lastAt: NOW },
  { from: 'api-worker', to: 'main', count: 1, lastAt: 0 },
];

const denyPeers: AutoApproveRule = {
  id: 'deny-peers',
  enabled: true,
  behavior: 'deny',
  tool: 'SendMessage',
  pattern: 'uds:*',
  description: 'No other sessions',
};

const allowAll: AutoApproveRule = {
  id: 'allow-all',
  enabled: false,
  behavior: 'allow',
  tool: '*',
  pattern: null,
  description: '',
};

const state: MessagesState = {
  messages,
  routes,
  inboundPolicy: 'hold',
  inboundChoices: ['accept', 'hold', 'refuse'],
  rules: [denyPeers, allowAll],
};

const empty: MessagesState = {
  messages: [],
  routes: [],
  inboundPolicy: null,
  inboundChoices: ['accept', 'hold', 'refuse'],
  rules: [],
};

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('MessagesView', () => {
  it('renders every section and passes axe', async () => {
    const { container } = renderView(<MessagesView state={state} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Agent messages' })).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toStrictEqual([
      'Message log',
      'Messages from your other sessions',
      'Block rules for SendMessage',
    ]);
    expect(screen.getByText('Message routes', { selector: 'figcaption' })).toBeDefined();
    const stats = screen.getAllByRole('definition').map((item) => item.textContent);
    expect(stats).toStrictEqual(['4', '2', '1']);
    await expectAccessible(container);
  });

  it('renders empty states and passes axe', async () => {
    const { container } = renderView(<MessagesView state={empty} />);
    expect(screen.getByText('No data yet.')).toBeDefined();
    expect(screen.getByText('No messages match.')).toBeDefined();
    expect(screen.getByText('No rules. Every send goes through.')).toBeDefined();
    expect(
      within(region('Messages from your other sessions')).getByText('not set', {
        selector: 'p span',
      }),
    ).toBeDefined();
    await expectAccessible(container);
  });
});

describe('route table and title', () => {
  it('lists every route with its last time', () => {
    const table = routeTable(routes);
    expect(table.columns).toStrictEqual(['From', 'To', 'Messages', 'Last']);
    expect(table.rows.map((row) => row.slice(0, 3))).toStrictEqual([
      ['main', AGENT, '3'],
      ['api-worker', 'main', '1'],
    ]);
    expect(table.rows[1]?.[3]).toBe('unknown');
    expect(table.rows[0]?.[3]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
  });

  it('says when the graph leaves routes out', () => {
    expect(graphTitle(routes)).toBe('Message routes');
    const many = Array.from({ length: 41 }, (_, index) => ({
      from: 'main',
      to: String(index),
      count: 1,
      lastAt: 0,
    }));
    expect(graphTitle(many)).toBe('Message routes (busiest 40 of 41)');
  });
});

describe('message log', () => {
  it('shows a row per message with short names and a blocked badge', () => {
    renderView(<MessagesView state={state} />);
    const log = region('Message log');
    const rows = within(log).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toStrictEqual([
      expect.stringContaining('maina0123456SendStart the auditsent'),
      expect.stringContaining('a0123456mainHand-backAudit finishedsent'),
      expect.stringContaining('mainsession 77SendYour branch is mergedblocked'),
      'unknownapi-workermainReceiveReadysent',
    ]);
    expect(within(log).getAllByTitle(AGENT)).toHaveLength(2);
    expect(within(log).getByText('Showing 4 of 4 messages.')).toBeDefined();
  });

  it('filters by text, kind and blocked', async () => {
    renderView(<MessagesView state={state} />);
    const log = region('Message log');
    await userEvent.type(within(log).getByRole('searchbox', { name: 'Filter' }), 'audit');
    expect(within(log).getByText('Showing 2 of 4 messages.')).toBeDefined();
    await userEvent.selectOptions(within(log).getByRole('combobox', { name: 'Kind' }), 'hand-back');
    expect(within(log).getByText('Showing 1 of 4 messages.')).toBeDefined();
    await userEvent.selectOptions(within(log).getByRole('combobox', { name: 'Kind' }), 'all');
    await userEvent.clear(within(log).getByRole('searchbox', { name: 'Filter' }));
    await userEvent.click(within(log).getByRole('checkbox', { name: 'Blocked only' }));
    expect(within(log).getByText('Showing 1 of 4 messages.')).toBeDefined();
    await userEvent.click(within(log).getByRole('checkbox', { name: 'Blocked only' }));
    expect(within(log).getByText('Showing 4 of 4 messages.')).toBeDefined();
  });

  it('filters in pure code too', () => {
    const all: LogFilter = { text: '', kind: 'all', blockedOnly: false };
    expect(filterMessages(messages, all)).toHaveLength(4);
    expect(filterMessages(messages, { ...all, text: 'API  main' })).toHaveLength(1);
    expect(filterMessages(messages, { ...all, kind: 'receive' })).toHaveLength(1);
    expect(toKindFilter('broadcast')).toBe('broadcast');
    expect(toKindFilter('nonsense')).toBe('all');
  });
});

describe('inbound policy', () => {
  it('explains each choice and saves the picked one', async () => {
    const { api } = renderView(<MessagesView state={state} />);
    const section = region('Messages from your other sessions');
    expect(within(section).getByText('Deliver each message to Claude.')).toBeDefined();
    const save = within(section).getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    expect(within(section).getByRole('radio', { name: 'hold' })).toHaveProperty('checked', true);
    await userEvent.click(within(section).getByRole('radio', { name: 'refuse' }));
    expect(save).toHaveProperty('disabled', false);
    await userEvent.click(save);
    await userEvent.click(within(section).getByRole('radio', { name: 'not set' }));
    await userEvent.click(save);
    expect(api.actions()).toStrictEqual([
      { type: 'setInboundPolicy', value: 'refuse' },
      { type: 'setInboundPolicy', value: null },
    ]);
  });

  it('has a fallback explanation for a value it does not know', () => {
    expect(inboundHelp('accept')).toBe('Deliver each message to Claude.');
    expect(inboundHelp('later')).toBe('A value Claude Code may not recognize.');
  });

  it('lists a choice the catalog adds', () => {
    renderView(<MessagesView state={{ ...state, inboundChoices: ['accept', 'later'] }} />);
    expect(screen.getByText('A value Claude Code may not recognize.')).toBeDefined();
  });
});

describe('block rules', () => {
  it('lists the rules, toggles and deletes them', async () => {
    const { api } = renderView(<MessagesView state={state} />);
    const section = region('Block rules for SendMessage');
    expect(within(section).getByText('block')).toBeDefined();
    expect(within(section).getByText('allow (no effect)')).toBeDefined();
    await userEvent.click(within(section).getByRole('checkbox', { name: 'Enable rule for uds:*' }));
    await userEvent.click(
      within(section).getByRole('checkbox', { name: 'Enable rule for every recipient' }),
    );
    await userEvent.click(within(section).getByRole('button', { name: 'Delete rule for uds:*' }));
    expect(api.actions()).toStrictEqual([
      { type: 'saveRule', rule: { ...denyPeers, enabled: false } },
      { type: 'saveRule', rule: { ...allowAll, enabled: true } },
      { type: 'deleteRule', ruleId: 'deny-peers' },
    ]);
  });

  it('adds a deny rule for a recipient pattern', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(36 ** 3);
    const { api } = renderView(<MessagesView state={empty} />);
    const section = region('Block rules for SendMessage');
    const add = within(section).getByRole('button', { name: 'Add block rule' });
    expect(add).toHaveProperty('disabled', true);
    const pattern = within(section).getByRole('textbox', { name: 'Recipient pattern' });
    await userEvent.type(pattern, '  ');
    expect(add).toHaveProperty('disabled', true);
    await userEvent.type(pattern, 'wt-apps-* ');
    await userEvent.type(within(section).getByRole('textbox', { name: 'Note' }), ' Quiet ');
    await userEvent.click(add);
    expect(api.actions()).toStrictEqual([
      {
        type: 'saveRule',
        rule: {
          id: 'rule-1000',
          enabled: true,
          behavior: 'deny',
          tool: 'SendMessage',
          pattern: 'wt-apps-*',
          description: 'Quiet',
        },
      },
    ]);
    expect(pattern).toHaveProperty('value', '');
  });

  it('builds a block rule in pure code', () => {
    expect(newBlockRule(' main ', '', 'r1')).toStrictEqual({
      id: 'r1',
      enabled: true,
      behavior: 'deny',
      tool: 'SendMessage',
      pattern: 'main',
      description: '',
    });
  });
});
