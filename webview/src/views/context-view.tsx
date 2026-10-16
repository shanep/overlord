// Context inspector: everything that drove the model for one session, and
// what did not load and why.

import type { ReactElement, ReactNode } from 'react';

import type { ContextState } from '../../../src/shared/protocol.js';
import { EmptyState } from '../components/empty-state.js';
import { formatDateTime } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { McpInstructions, PlainList, SystemPrompt, WeightTreemap } from './context-sections.js';
import { EnvironmentTable, LoadedTable, SkillsTable, SkippedTable } from './context-tables.js';

function Section(props: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="section" aria-labelledby={props.id}>
      <h2 id={props.id}>{props.title}</h2>
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
    <label>
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

export function ContextView(props: { readonly state: ContextState }): ReactElement {
  const { snapshot, sessions } = props.state;
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
          <Section id="ctx-weights" title="Token weight">
            <WeightTreemap weights={snapshot.weights} />
          </Section>
          <Section id="ctx-prompt" title="System prompt">
            <SystemPrompt blocks={snapshot.systemPrompt} />
          </Section>
          <Section id="ctx-loaded" title="Memory files loaded">
            <LoadedTable loaded={snapshot.loaded} />
          </Section>
          <Section id="ctx-skipped" title="Did not load">
            <SkippedTable skipped={snapshot.skipped} />
          </Section>
          <Section id="ctx-skills" title="Skills">
            <SkillsTable skills={snapshot.skills} />
          </Section>
          <Section id="ctx-agents" title="Agent types">
            <PlainList label="Agent types" items={snapshot.agentTypes} />
          </Section>
          <Section id="ctx-mcp" title="MCP instructions">
            <McpInstructions servers={snapshot.mcpServers} />
          </Section>
          <Section id="ctx-deferred" title="Deferred tools">
            <PlainList label="Deferred tools" items={snapshot.deferredTools} />
          </Section>
          <Section id="ctx-env" title="Environment">
            <EnvironmentTable environment={snapshot.environment} />
          </Section>
        </>
      )}
    </section>
  );
}
