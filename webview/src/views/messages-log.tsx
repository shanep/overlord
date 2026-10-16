// The message log: every message the scan found, newest first, filterable by
// text, kind and whether a rule blocked it.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { AgentMessage } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import { formatDateTime } from '../format.js';

import { shortName } from './messages-graph.js';

export type KindFilter = AgentMessage['kind'] | 'all';

const KIND_LABELS: Readonly<Record<AgentMessage['kind'], string>> = {
  send: 'Send',
  receive: 'Receive',
  broadcast: 'Broadcast',
  'hand-back': 'Hand-back',
  'task-notification': 'Agent finished',
};

const KINDS: readonly AgentMessage['kind'][] = [
  'send',
  'receive',
  'broadcast',
  'hand-back',
  'task-notification',
];

export interface LogFilter {
  readonly text: string;
  readonly kind: KindFilter;
  readonly blockedOnly: boolean;
}

export function toKindFilter(value: string): KindFilter {
  return KINDS.find((kind) => kind === value) ?? 'all';
}

export function filterMessages(
  messages: readonly AgentMessage[],
  filter: LogFilter,
): readonly AgentMessage[] {
  const words = filter.text.toLowerCase().split(/\s+/u);
  return messages.filter((message) => {
    if (filter.kind !== 'all' && message.kind !== filter.kind) {
      return false;
    }
    if (filter.blockedOnly && !message.blocked) {
      return false;
    }
    const haystack = `${message.from} ${message.to} ${message.preview}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

function Party(props: { readonly name: string }): ReactElement {
  const short = shortName(props.name);
  return (
    <span className="mono" title={short === props.name ? undefined : props.name}>
      {short}
    </span>
  );
}

function LogRow(props: { readonly message: AgentMessage }): ReactElement {
  const { message } = props;
  return (
    <tr>
      <td className="mono">{message.at === 0 ? 'unknown' : formatDateTime(message.at)}</td>
      <td>
        <Party name={message.from} />
      </td>
      <td>
        <Party name={message.to} />
      </td>
      <td>{KIND_LABELS[message.kind]}</td>
      <td className="wrap">{message.preview}</td>
      <td>
        {message.blocked ? (
          <Badge label="blocked" tone="critical" />
        ) : (
          <span className="muted">sent</span>
        )}
      </td>
    </tr>
  );
}

export function MessageLog(props: { readonly messages: readonly AgentMessage[] }): ReactElement {
  const [filter, setFilter] = useState<LogFilter>({ text: '', kind: 'all', blockedOnly: false });
  const shown = filterMessages(props.messages, filter);
  return (
    <section className="section" aria-labelledby="message-log-heading">
      <h2 id="message-log-heading">Message log</h2>
      <div className="toolbar">
        <label>
          Filter
          <input
            type="search"
            value={filter.text}
            placeholder="agent, session or text"
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
                {KIND_LABELS[kind]}
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
        {`Showing ${String(shown.length)} of ${String(props.messages.length)} messages.`}
      </p>
      <table className="grid">
        <caption className="visually-hidden">Messages between agents and sessions</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Kind</th>
            <th scope="col">Preview</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No messages match.
              </td>
            </tr>
          ) : (
            shown.map((message) => <LogRow key={message.id} message={message} />)
          )}
        </tbody>
      </table>
    </section>
  );
}
