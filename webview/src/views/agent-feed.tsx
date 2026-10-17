// The live feed of one agent, oldest first. Thinking and tool input start
// collapsed so the feed reads like a log.

import type { ReactElement } from 'react';

import type { FeedItem } from '../../../src/shared/model.js';
import { plainText } from '../../../src/shared/plain-text.js';
import { Badge } from '../components/badge.js';
import { JsonView } from '../components/json-view.js';
import { formatClock } from '../format.js';

function FeedBody(props: { readonly item: FeedItem }): ReactElement {
  const { item } = props;
  switch (item.kind) {
    case 'thinking': {
      return (
        <details>
          <summary>Show thinking</summary>
          <p className="feed-text">{plainText(item.text)}</p>
        </details>
      );
    }
    case 'tool_use': {
      return (
        <details>
          <summary>
            <span className="mono">{item.name}</span> input
          </summary>
          <JsonView value={item.input} />
        </details>
      );
    }
    case 'tool_result': {
      return (
        <>
          <Badge label={item.ok ? 'ok' : 'error'} tone={item.ok ? 'good' : 'critical'} />
          <p className="feed-text">{plainText(item.text)}</p>
        </>
      );
    }
    case 'user':
    case 'text':
    case 'system': {
      return <p className="feed-text">{plainText(item.text)}</p>;
    }
  }
}

const KIND_LABELS: Readonly<Record<FeedItem['kind'], string>> = {
  user: 'You',
  text: 'Claude',
  thinking: 'Thinking',
  tool_use: 'Tool call',
  tool_result: 'Result',
  system: 'System',
};

function feedClass(item: FeedItem): string {
  if (item.kind === 'tool_result' && !item.ok) {
    return 'feed-error';
  }
  if (item.kind === 'tool_use' || item.kind === 'tool_result') {
    return 'feed-tool';
  }
  return `feed-${item.kind}`;
}

export function AgentFeed(props: { readonly feed: readonly FeedItem[] }): ReactElement {
  const { feed } = props;
  if (feed.length === 0) {
    return <p className="muted">Nothing in the feed yet.</p>;
  }
  const ordered = feed.toSorted((a, b) => a.at - b.at);
  return (
    <ol className="feed agent-feed-list" aria-label="Feed">
      {ordered.map((item) => (
        <li key={item.id} className={feedClass(item)}>
          <div className="feed-meta">
            <span className="feed-kind">{KIND_LABELS[item.kind]}</span>
            <time dateTime={new Date(item.at).toISOString()}>{formatClock(item.at)}</time>
          </div>
          <FeedBody item={item} />
        </li>
      ))}
    </ol>
  );
}
