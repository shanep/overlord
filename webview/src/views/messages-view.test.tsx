// Row text is concatenated cell text. cspell:ignore conversationAudit codeMessageStart codeMain conversationReportAudit conversationSession workerMain conversationMessageReady Messageblocked unknownapi
// Synthetic messages only.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AgentMessage, MessageRoute, MessagesState } from '../../../src/shared/protocol.js';
import type { AutoApproveRule } from '../../../src/shared/rules.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { inboundHelp } from './messages-inbound.js';
import type { LogFilter } from './messages-log.js';
import {
  filterMessages,
  groupBySession,
  kindLabel,
  OPEN_GROUPS,
  toKindFilter,
} from './messages-log.js';
import { newBlockRule } from './messages-rules.js';
import { graphTitle, MessagesView, routeTable } from './messages-view.js';

const AGENT = 'a0123456789abcdef';

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'id'>): AgentMessage {
  return {
    at: NOW - 60_000,
    sessionId: 's1',
    sessionTitle: 'Audit run',
    from: 'main',
    to: AGENT,
    fromName: 'Main conversation',
    toName: 'Audit the code',
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
    fromName: 'Audit the code',
    toName: 'Main conversation',
    kind: 'hand-back',
    preview: 'Audit finished',
  }),
  message({
    id: 'm3',
    to: 'uds:/tmp/cc-socks/77.sock',
    toName: 'Session with pid 77',
    preview: 'Your branch is merged',
    blocked: true,
  }),
  message({
    id: 'm4',
    sessionId: 's2',
    sessionTitle: 'API worker',
    from: 'api-worker',
    to: 'main',
    fromName: 'api-worker',
    toName: 'Main conversation',
    kind: 'receive',
    at: 0,
    preview: 'Ready',
  }),
];

const routes: readonly MessageRoute[] = [
  { from: 'Audit run', to: 'Session with pid 77', count: 3, lastAt: NOW },
  { from: 'api-worker', to: 'API worker', count: 1, lastAt: 0 },
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

/** Body rows of every session table in the log, in order. */
function logRows(log: HTMLElement): string[] {
  return within(log)
    .getAllByRole('table')
    .flatMap((table) => within(table).getAllByRole('row').slice(1))
    .map((row) => row.textContent);
}

describe('MessagesView', () => {
  it('renders every section and passes axe', async () => {
    const { container } = renderView(<MessagesView state={state} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Agent messages' })).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toStrictEqual([
      'Messages by session',
      'Messages from your other sessions',
      'Block rules for SendMessage',
    ]);
    expect(screen.getByText('Messages between sessions', { selector: 'figcaption' })).toBeDefined();
    const stats = screen.getAllByRole('definition').map((item) => item.textContent);
    expect(stats).toStrictEqual(['4', '2', '4', '1']);
    await expectAccessible(container);
  });

  it('renders empty states without a graph and passes axe', async () => {
    const { container } = renderView(<MessagesView state={empty} />);
    expect(screen.queryByText('Messages between sessions')).toBeNull();
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
    expect(table.columns).toStrictEqual(['From session', 'To session', 'Messages', 'Last']);
    expect(table.rows.map((row) => row.slice(0, 3))).toStrictEqual([
      ['Audit run', 'Session with pid 77', '3'],
      ['api-worker', 'API worker', '1'],
    ]);
    expect(table.rows[1]?.[3]).toBe('unknown');
    expect(table.rows[0]?.[3]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
  });

  it('says when the graph leaves routes out', () => {
    expect(graphTitle(routes)).toBe('Messages between sessions');
    const many = Array.from({ length: 41 }, (_, index) => ({
      from: 'hub',
      to: String(index),
      count: 1,
      lastAt: 0,
    }));
    expect(graphTitle(many)).toBe('Messages between sessions (busiest 40 of 41)');
  });
});

describe('message log', () => {
  it('groups rows by session with readable names and a blocked badge', () => {
    renderView(<MessagesView state={state} />);
    const log = region('Messages by session');
    expect(
      [...log.querySelectorAll('summary')].map((summary) => summary.textContent),
    ).toStrictEqual([
      expect.stringMatching(/^Audit run 3 messages, last \d{4}-/u),
      'API worker 1 message, last unknown',
    ]);
    expect(logRows(log)).toStrictEqual([
      expect.stringContaining('Main conversationAudit the codeMessageStart the audit'),
      expect.stringContaining('Audit the codeMain conversationReportAudit finished'),
      expect.stringContaining('Main conversationSession with pid 77Messageblocked Your branch'),
      'unknownapi-workerMain conversationMessageReady',
    ]);
    // The raw address shows on hover when the name differs from it.
    expect(within(log).getAllByTitle(AGENT)).toHaveLength(2);
    expect(within(log).queryAllByTitle('api-worker')).toHaveLength(0);
    expect(within(log).getByText('Showing 4 of 4 messages in 2 sessions.')).toBeDefined();
  });

  it('filters by text, kind and blocked', async () => {
    renderView(<MessagesView state={state} />);
    const log = region('Messages by session');
    await userEvent.type(within(log).getByRole('searchbox', { name: 'Filter' }), 'audit');
    expect(within(log).getByText('Showing 3 of 4 messages in 1 session.')).toBeDefined();
    await userEvent.selectOptions(within(log).getByRole('combobox', { name: 'Kind' }), 'report');
    expect(within(log).getByText('Showing 1 of 4 messages in 1 session.')).toBeDefined();
    await userEvent.selectOptions(within(log).getByRole('combobox', { name: 'Kind' }), 'all');
    await userEvent.clear(within(log).getByRole('searchbox', { name: 'Filter' }));
    await userEvent.click(within(log).getByRole('checkbox', { name: 'Blocked only' }));
    expect(within(log).getByText('Showing 1 of 4 messages in 1 session.')).toBeDefined();
    await userEvent.click(within(log).getByRole('checkbox', { name: 'Blocked only' }));
    expect(within(log).getByText('Showing 4 of 4 messages in 2 sessions.')).toBeDefined();
    await userEvent.type(within(log).getByRole('searchbox', { name: 'Filter' }), 'nothing like it');
    expect(within(log).getByText('No messages match.')).toBeDefined();
  });

  it('opens the newest sessions, and every session while a filter is on', async () => {
    const many = Array.from({ length: OPEN_GROUPS + 1 }, (_, index) =>
      message({ id: `g${String(index)}`, sessionId: `s${String(index)}`, at: NOW - index }),
    );
    renderView(<MessagesView state={{ ...state, messages: many }} />);
    const log = region('Messages by session');
    const open = (): boolean[] =>
      [...log.querySelectorAll('details')].map((details) => details.open);
    expect(OPEN_GROUPS).toBe(3);
    expect(open()).toStrictEqual([true, true, true, false]);
    await userEvent.selectOptions(within(log).getByRole('combobox', { name: 'Kind' }), 'message');
    expect(open()).toStrictEqual([true, true, true, true]);
  });

  it('filters, groups and labels in pure code too', () => {
    const all: LogFilter = { text: '', kind: 'all', blockedOnly: false };
    expect(filterMessages(messages, all)).toHaveLength(4);
    expect(filterMessages(messages, { ...all, text: 'API  main' })).toHaveLength(1);
    expect(filterMessages(messages, { ...all, text: 'pid 77' })).toHaveLength(1);
    expect(filterMessages(messages, { ...all, text: 'uds:' })).toHaveLength(1);
    expect(filterMessages(messages, { ...all, kind: 'message' })).toHaveLength(3);
    expect(filterMessages(messages, { ...all, kind: 'status' })).toHaveLength(0);
    expect(toKindFilter('report')).toBe('report');
    expect(toKindFilter('hand-back')).toBe('all');
    expect(messages.map((item) => kindLabel(item))).toStrictEqual([
      'Message',
      'Report',
      'Message',
      'Message',
    ]);
    expect(kindLabel(message({ id: 'n', kind: 'task-notification' }))).toBe('Status');
    expect(kindLabel(message({ id: 'b', kind: 'broadcast' }))).toBe('Message');
    expect(
      groupBySession(messages).map((group) => [group.title, group.messages.length]),
    ).toStrictEqual([
      ['Audit run', 3],
      ['API worker', 1],
    ]);
    expect(groupBySession([])).toStrictEqual([]);
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
