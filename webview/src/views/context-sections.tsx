// The smaller context inspector sections: system prompt blocks, plain
// lists, MCP instructions and the token weight treemap.

import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { ContextSnapshot } from '../../../src/shared/model.js';
import { useChartTheme } from '../charts/chart-theme.js';
import type { WeightEntry } from '../charts/context-treemap.js';
import { buildContextTreemap, weightLabel } from '../charts/context-treemap.js';
import { ChartFigure } from '../components/chart-figure.js';
import { formatInteger, truncate } from '../format.js';

/** First non blank line of a prompt block, cut short for a summary. */
export function blockSummary(block: string): string {
  const first = block.split('\n').find((line) => line.trim() !== '') ?? '';
  return first === '' ? '(empty)' : truncate(first.trim(), 80);
}

export function SystemPrompt(props: { readonly blocks: readonly string[] | null }): ReactElement {
  const { blocks } = props;
  if (blocks === null) {
    return <p className="muted">Not captured for this session.</p>;
  }
  return (
    <div>
      {blocks.map((block, index) => (
        // Blocks have no ids, and their order is the prompt order.
        <details key={index}>
          <summary>
            Block {index + 1}: {blockSummary(block)}
          </summary>
          <pre className="json">{block}</pre>
        </details>
      ))}
    </div>
  );
}

export function PlainList(props: {
  readonly label: string;
  readonly items: readonly string[];
}): ReactElement {
  if (props.items.length === 0) {
    return <p className="muted">None.</p>;
  }
  return (
    <ul className="chips" aria-label={props.label}>
      {props.items.map((item) => (
        <li key={item} className="badge">
          {item}
        </li>
      ))}
    </ul>
  );
}

export function McpInstructions(props: {
  readonly servers: ContextSnapshot['mcpServers'];
}): ReactElement {
  if (props.servers.length === 0) {
    return <p className="muted">No MCP server instructions.</p>;
  }
  return (
    <div>
      {props.servers.map((server) => (
        <details key={server.name}>
          <summary>{server.name}</summary>
          <pre className="json">{server.instructions}</pre>
        </details>
      ))}
    </div>
  );
}

export function WeightTreemap(props: { readonly weights: readonly WeightEntry[] }): ReactElement {
  const theme = useChartTheme();
  const { weights } = props;
  const option = useMemo(() => buildContextTreemap(weights, theme), [weights, theme]);
  return (
    <ChartFigure
      title="Token weight"
      option={option}
      height={220}
      table={{
        columns: ['Piece', 'Tokens', 'Estimated'],
        rows: weights.map((entry) => [
          weightLabel(entry),
          formatInteger(entry.tokens),
          entry.estimated ? 'Yes' : 'No',
        ]),
      }}
    />
  );
}
