// Context inspector: everything that drove the model for one session, and
// what did not load and why. What you act on stays open; the reference
// sections fold away with a count.

import type { ReactElement, ReactNode } from 'react';

import type { ContextState } from '../../../src/shared/protocol.js';
import { useAgent } from '../agents.js';
import { StatTile, StatTiles } from '../components/card.js';
import { EmptyState } from '../components/empty-state.js';
import { Fold } from '../components/fold.js';
import { formatCompact, formatDateTime } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { McpInstructions, PlainList, SystemPrompt, WeightTreemap } from './context-sections.js';
import { EnvironmentTable, LoadedTable, SkillsTable, SkippedTable } from './context-tables.js';

function Section(props: {
  readonly id: string;
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="section" aria-labelledby={props.id}>
      <h2 id={props.id} className="section-title">
        {props.title}
        {props.count === undefined ? null : <span className="count">{String(props.count)}</span>}
      </h2>
      {props.children}
    </section>
  );
}

function SessionPicker(props: {
  readonly sessions: ContextState['sessions'];
  readonly selected: string;
}): ReactElement {
  const post = usePostAction();
  return (
    <label className="context-picker">
      Session
      <select
        value={props.selected}
        onChange={(event) => {
          const sessionId = event.target.value;
          if (sessionId !== '') {
            post({ type: 'openContext', sessionId, agentId: null });
          }
        }}
      >
        <option value="">Pick a session</option>
        {props.sessions.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

export function ContextView(props: { readonly state: ContextState }): ReactElement {
  const { snapshot, sessions } = props.state;
  const agent = useAgent(props.state.agent);
  // Instruction files and skills come from the agent's folders. The rest needs
  // the full context capture only some agents give.
  const { contextInspector: full, subagents } = agent.capabilities;
  return (
    <section aria-label="Context">
      <div className="view-header">
        <h1>Context</h1>
        <SessionPicker sessions={sessions} selected={snapshot?.sessionId ?? ''} />
        {snapshot === null ? null : (
          <span className="muted">
            {snapshot.model ?? 'unknown model'}, as of {formatDateTime(snapshot.at)}
          </span>
        )}
      </div>
      {snapshot === null ? (
        <EmptyState title="No context yet" detail="Pick a session to see what drives it." />
      ) : (
        <>
          <StatTiles label="Context numbers">
            <StatTile
              label="Tokens"
              value={formatCompact(snapshot.weights.reduce((sum, entry) => sum + entry.tokens, 0))}
            />
            <StatTile label="Memory files" value={String(snapshot.loaded.length)} />
            <StatTile label="Did not load" value={String(snapshot.skipped.length)} />
            <StatTile label="Skills" value={String(snapshot.skills.length)} />
            <StatTile label="MCP servers" value={String(snapshot.mcpServers.length)} />
          </StatTiles>
          {full ? (
            <Section id="ctx-weights" title="Where the tokens go">
              <WeightTreemap weights={snapshot.weights} />
            </Section>
          ) : null}
          <Section id="ctx-loaded" title="Memory files loaded" count={snapshot.loaded.length}>
            <div className="panel">
              <LoadedTable loaded={snapshot.loaded} />
            </div>
          </Section>
          <Section id="ctx-skipped" title="Did not load" count={snapshot.skipped.length}>
            <div className="panel">
              <SkippedTable skipped={snapshot.skipped} />
            </div>
          </Section>
          <Section id="ctx-skills" title="Skills" count={snapshot.skills.length}>
            <div className="panel">
              <SkillsTable skills={snapshot.skills} />
            </div>
          </Section>
          {full ? (
            <>
              <Fold
                id="ctx-prompt"
                title="System prompt"
                note={
                  snapshot.systemPrompt === null
                    ? 'not captured'
                    : plural(snapshot.systemPrompt.length, 'block', 'blocks')
                }
              >
                <SystemPrompt blocks={snapshot.systemPrompt} />
              </Fold>
              <Fold
                id="ctx-mcp"
                title="MCP instructions"
                note={plural(snapshot.mcpServers.length, 'server', 'servers')}
              >
                <McpInstructions servers={snapshot.mcpServers} />
              </Fold>
            </>
          ) : null}
          {full && subagents ? (
            <Fold
              id="ctx-agents"
              title="Agent types"
              note={plural(snapshot.agentTypes.length, 'type', 'types')}
            >
              <PlainList label="Agent types" items={snapshot.agentTypes} />
            </Fold>
          ) : null}
          {full ? (
            <>
              <Fold
                id="ctx-deferred"
                title="Deferred tools"
                note={plural(snapshot.deferredTools.length, 'tool', 'tools')}
              >
                <PlainList label="Deferred tools" items={snapshot.deferredTools} />
              </Fold>
              <Fold
                id="ctx-env"
                title="Environment"
                note={plural(Object.keys(snapshot.environment).length, 'value', 'values')}
              >
                <div className="panel">
                  <EnvironmentTable environment={snapshot.environment} />
                </div>
              </Fold>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
