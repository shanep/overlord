// The message log: one group per session, the session with the newest
// message first, filterable by text, kind and whether a rule blocked it.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { AgentMessage } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import { formatDateTime, formatInteger } from '../format.js';

type MessageKind = 'message' | 'report' | 'status';

export type KindFilter = MessageKind | 'all';

/** Sends, deliveries and broadcasts all read as plain messages. */
const KIND_OF: Readonly<Record<AgentMessage['kind'], MessageKind>> = {
  send: 'message',
  receive: 'message',
  broadcast: 'message',
  'hand-back': 'report',
  'task-notification': 'status',
};

const KIND_LABELS: Readonly<Record<MessageKind, string>> = {
  message: 'Message',
  report: 'Report',
  status: 'Status',
};

const FILTER_LABELS: Readonly<Record<MessageKind, string>> = {
  message: 'Messages',
  report: 'Agent reports',
  status: 'Status updates',
};

const KINDS: readonly MessageKind[] = ['message', 'report', 'status'];

/** Groups open at first; the rest wait for a click or a filter. */
export const OPEN_GROUPS = 3;

export interface LogFilter {
  readonly text: string;
  readonly kind: KindFilter;
  readonly blockedOnly: boolean;
}

export interface SessionGroup {
  readonly sessionId: string;
  readonly title: string;
  readonly messages: readonly AgentMessage[];
}

export function toKindFilter(value: string): KindFilter {
  return KINDS.find((kind) => kind === value) ?? 'all';
}

export function kindLabel(message: AgentMessage): string {
  return KIND_LABELS[KIND_OF[message.kind]];
}

export function filterMessages(
  messages: readonly AgentMessage[],
  filter: LogFilter,
): readonly AgentMessage[] {
  const words = filter.text.toLowerCase().split(/\s+/u);
  return messages.filter((message) => {
    if (filter.kind !== 'all' && KIND_OF[message.kind] !== filter.kind) {
      return false;
    }
    if (filter.blockedOnly && !message.blocked) {
      return false;
    }
    const haystack = [
      message.sessionTitle,
      message.fromName,
      message.toName,
      message.from,
      message.to,
      message.preview,
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Groups in the order their first message comes, so newest first for a newest-first list. */
export function groupBySession(messages: readonly AgentMessage[]): readonly SessionGroup[] {
  const groups = new Map<string, AgentMessage[]>();
  for (const message of messages) {
    const group = groups.get(message.sessionId);
    if (group === undefined) {
      groups.set(message.sessionId, [message]);
    } else {
      group.push(message);
    }
  }
  return [...groups.entries()].map(([sessionId, items]) => ({
    sessionId,
    title: items[0]?.sessionTitle ?? sessionId,
    messages: items,
  }));
}

function time(at: number): string {
  return at === 0 ? 'unknown' : formatDateTime(at);
}

function Party(props: { readonly name: string; readonly address: string }): ReactElement {
  return <span title={props.name === props.address ? undefined : props.address}>{props.name}</span>;
}

function LogRow(props: { readonly message: AgentMessage }): ReactElement {
  const { message } = props;
  return (
    <tr>
      <td className="mono">{time(message.at)}</td>
      <td className="wrap">
        <Party name={message.fromName} address={message.from} />
      </td>
      <td className="wrap">
        <Party name={message.toName} address={message.to} />
      </td>
      <td>{kindLabel(message)}</td>
      <td className="wrap">
        {message.blocked ? (
          <>
            <Badge label="blocked" tone="critical" />{' '}
          </>
        ) : null}
        {message.preview}
      </td>
    </tr>
  );
}

function count(items: number, word: string): string {
  const noun = items === 1 ? word : `${word}s`;
  return `${formatInteger(items)} ${noun}`;
}

function Group(props: { readonly group: SessionGroup; readonly open: boolean }): ReactElement {
  const { group } = props;
  const newest = group.messages[0]?.at ?? 0;
  return (
    <details open={props.open} className="message-group">
      <summary>
        <strong>{group.title}</strong>{' '}
        <span className="muted">{`${count(group.messages.length, 'message')}, last ${time(newest)}`}</span>
      </summary>
      <table className="grid message-log">
        <caption className="visually-hidden">{`Messages in ${group.title}`}</caption>
        <colgroup>
          <col className="col-time" />
          <col className="col-party" />
          <col className="col-party" />
          <col className="col-kind" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Kind</th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>
          {group.messages.map((message) => (
            <LogRow key={message.id} message={message} />
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function MessageLog(props: { readonly messages: readonly AgentMessage[] }): ReactElement {
  const [filter, setFilter] = useState<LogFilter>({ text: '', kind: 'all', blockedOnly: false });
  const shown = filterMessages(props.messages, filter);
  const groups = groupBySession(shown);
  const filtering = filter.text.trim() !== '' || filter.kind !== 'all' || filter.blockedOnly;
  return (
    <section className="section" aria-labelledby="message-log-heading">
      <h2 id="message-log-heading" className="section-title">
        Messages by session
      </h2>
      <div className="toolbar">
        <label>
          Filter
          <input
            type="search"
            value={filter.text}
            placeholder="session, agent or text"
            onChange={(event) => {
              setFilter({ ...filter, text: event.target.value });
            }}
          />
        </label>
        <label>
          Kind
          <select
            value={filter.kind}
            onChange={(event) => {
              setFilter({ ...filter, kind: toKindFilter(event.target.value) });
            }}
          >
            <option value="all">All kinds</option>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {FILTER_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={filter.blockedOnly}
            onChange={() => {
              setFilter({ ...filter, blockedOnly: !filter.blockedOnly });
            }}
          />
          Blocked only
        </label>
      </div>
      <p className="muted" role="status">
        {`Showing ${formatInteger(shown.length)} of ${count(props.messages.length, 'message')} in ${count(groups.length, 'session')}.`}
      </p>
      {groups.length === 0 ? <p className="muted">No messages match.</p> : null}
      {groups.map((group, index) => (
        // A new key when filtering starts or stops resets which groups are open.
        <Group
          key={`${group.sessionId}:${String(filtering)}`}
          group={group}
          open={filtering || index < OPEN_GROUPS}
        />
      ))}
    </section>
  );
}
