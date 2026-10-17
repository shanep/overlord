// The registry section under your connectors: browse or search the public MCP
// registry as a grid of cards, fill in what a server needs, and add it to the
// user scope of Claude Code or another installed agent with an MCP store.

import type { ReactElement, SubmitEvent } from 'react';
import { useState } from 'react';

import type { AgentId } from '../../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../../src/shared/agents.js';
import type {
  InstallInput,
  InstallKind,
  RegistryServer,
  RegistryState,
} from '../../../src/shared/connectors.js';
import { Badge } from '../components/badge.js';
import type { SegmentedOption } from '../components/card.js';
import { Avatar, Card, CardGrid, Notice, Segmented } from '../components/card.js';
import { usePostAction } from '../vscode-context.js';

import { AgentPick, InstallSameAs, useAgentChoice } from './connectors-agent-pick.js';

const INSTALL_KIND_LABELS: Readonly<Record<InstallKind, string>> = {
  http: 'Remote (HTTP)',
  sse: 'Remote (SSE)',
  npm: 'npm',
  pypi: 'PyPI',
  docker: 'Docker',
};

const NAME_PATTERN = /^[\w-]{1,64}$/u;

type KindFilter = 'all' | 'remote' | 'npm' | 'pypi' | 'docker';

const KIND_FILTERS: readonly SegmentedOption<KindFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'remote', label: 'Remote' },
  { value: 'npm', label: 'npm' },
  { value: 'pypi', label: 'PyPI' },
  { value: 'docker', label: 'Docker' },
];

function matchesKind(server: RegistryServer, filter: KindFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  return server.options.some((option) =>
    filter === 'remote' ? option.kind === 'http' || option.kind === 'sse' : option.kind === filter,
  );
}

function initialValues(inputs: readonly InstallInput[]): Record<string, string> {
  return Object.fromEntries(inputs.map((entry) => [entry.id, entry.initial]));
}

/** The card's heading: the registry title, or the last part of the name when it has none. */
function headingOf(server: RegistryServer): string {
  return server.title === server.name
    ? (server.name.split('/').at(-1) ?? server.name)
    : server.title;
}

function InputField(props: {
  readonly input: InstallInput;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { input } = props;
  const hintId = `hint-${input.id}`;
  return (
    <div>
      <label className="field">
        <span>
          {input.label}
          {input.required ? ' (required)' : ''}
        </span>
        <input
          type={input.secret ? 'password' : 'text'}
          value={props.value}
          placeholder={input.placeholder}
          aria-describedby={input.description === '' ? undefined : hintId}
          autoComplete="off"
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        />
      </label>
      {input.description === '' ? null : (
        <p id={hintId} className="hint">
          {input.description}
        </p>
      )}
    </div>
  );
}

function InstallForm(props: {
  readonly server: RegistryServer;
  readonly installing: boolean;
  readonly mcpAgents: readonly AgentId[];
  readonly onCancel: () => void;
}): ReactElement {
  const { server } = props;
  const post = usePostAction();
  const agentChoice = useAgentChoice(props.mcpAgents);
  const { target } = agentChoice;
  const [choice, setChoice] = useState(0);
  const [name, setName] = useState(server.suggestedName);
  const option = server.options[choice] ?? server.options[0];
  const [values, setValues] = useState(() => initialValues(option?.inputs ?? []));
  if (option === undefined) {
    return <p className="muted">There is no way to install this one from here.</p>;
  }
  const missing = option.inputs.filter(
    (entry) => entry.required && (values[entry.id] ?? '').trim() === '',
  );
  const nameOk = NAME_PATTERN.test(name.trim());
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const agent = target.id === CLAUDE_CODE ? {} : { agent: target.id };
    post({ type: 'installConnector', server: server.name, option: choice, name, values, ...agent });
  };
  return (
    <form className="card-form" onSubmit={submit} aria-label={`Install ${server.title}`}>
      <AgentPick choice={agentChoice} />
      {server.options.length > 1 ? (
        <label className="field">
          <span>Install as</span>
          <select
            value={choice}
            onChange={(event) => {
              const next = Number(event.target.value);
              setChoice(next);
              setValues(initialValues(server.options[next]?.inputs ?? []));
            }}
          >
            {server.options.map((entry, index) => (
              <option key={`${entry.kind}:${entry.summary}`} value={index}>
                {INSTALL_KIND_LABELS[entry.kind]}: {entry.summary}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="reg-command">
        <span className="muted">{INSTALL_KIND_LABELS[option.kind]}</span>
        <code>{option.summary}</code>
      </p>
      <div className="form-grid">
        <div>
          <label className="field">
            <span>Name in {target.name}</span>
            <input
              type="text"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </label>
          {nameOk ? null : (
            <p className="error-text" role="alert">
              Use only letters, digits, dashes and underscores.
            </p>
          )}
        </div>
        {option.inputs.map((entry) => (
          <InputField
            key={entry.id}
            input={entry}
            value={values[entry.id] ?? ''}
            onChange={(value) => {
              setValues({ ...values, [entry.id]: value });
            }}
          />
        ))}
      </div>
      <div className="form-actions">
        {missing.length > 0 ? (
          <span className="muted">Fill in {missing.map((entry) => entry.label).join(', ')}.</span>
        ) : null}
        <span className="spacer" />
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="primary"
          disabled={props.installing || missing.length > 0 || !nameOk}
        >
          {props.installing ? 'Installing…' : 'Install'}
        </button>
      </div>
    </form>
  );
}

function Result(props: {
  readonly server: RegistryServer;
  readonly mcpAgents: readonly AgentId[];
  readonly open: boolean;
  readonly installing: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  const { server } = props;
  const post = usePostAction();
  const kinds = [...new Set(server.options.map((entry) => entry.kind))];
  const { repository } = server;
  const heading = headingOf(server);
  return (
    <Card action open={props.open}>
      <div className="card-head">
        <Avatar seed={server.name} text={heading} />
        <div className="card-titles">
          <span className="card-title" title={heading}>
            {heading}
          </span>
          <span className="card-sub mono" title={server.name}>
            {server.name}
            {server.version === '' ? '' : ` · ${server.version}`}
          </span>
        </div>
      </div>
      {server.description === '' ? null : (
        <p className="card-text card-clamp" title={server.description}>
          {server.description}
        </p>
      )}
      <div className="card-foot">
        {kinds.map((kind) => (
          <span key={kind} className="chip">
            {INSTALL_KIND_LABELS[kind]}
          </span>
        ))}
        {server.options.length === 0 ? (
          <span className="chip chip-dashed">Not installable from here</span>
        ) : null}
        <span className="spacer" />
        {repository === null ? null : (
          <button
            type="button"
            className="link-button"
            title={repository}
            onClick={() => {
              post({ type: 'openRegistryLink', url: repository });
            }}
          >
            Repository
          </button>
        )}
        {server.options.length === 0 ? null : (
          <button type="button" disabled={props.busy && !props.open} onClick={props.onToggle}>
            {props.open ? 'Close' : 'Install…'}
          </button>
        )}
      </div>
      {props.open ? (
        <InstallForm
          server={server}
          installing={props.installing}
          mcpAgents={props.mcpAgents}
          onCancel={props.onToggle}
        />
      ) : null}
    </Card>
  );
}

function Results(props: {
  readonly registry: RegistryState;
  readonly mcpAgents: readonly AgentId[];
}): ReactElement | null {
  const { registry } = props;
  const post = usePostAction();
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  if (registry.query === null) {
    return null;
  }
  if (registry.results.length === 0) {
    if (registry.error !== null) {
      return null;
    }
    return (
      <p className="empty-line muted">
        {registry.searching ? 'Searching…' : 'No servers match that name.'}
      </p>
    );
  }
  const shown = registry.results.filter((server) => matchesKind(server, kind));
  const what =
    registry.query.trim() === ''
      ? 'servers from the registry'
      : `servers whose name has "${registry.query.trim()}"`;
  return (
    <>
      <div className="list-bar">
        <span className="muted">
          {String(registry.results.length)} {what}
          {registry.more ? ' so far' : ''}
          {kind === 'all' ? '' : `, ${String(shown.length)} shown`}
        </span>
        <span className="spacer" />
        <Segmented label="Runs as" options={KIND_FILTERS} value={kind} onChange={setKind} />
      </div>
      {shown.length === 0 ? (
        <p className="empty-line muted">
          None of these run that way. Show more or pick another filter.
        </p>
      ) : null}
      <CardGrid wide label="Registry results">
        {shown.map((server) => (
          <Result
            key={server.name}
            server={server}
            mcpAgents={props.mcpAgents}
            open={open === server.name}
            installing={registry.installing === server.name}
            busy={registry.installing !== null}
            onToggle={() => {
              setOpen(open === server.name ? null : server.name);
            }}
          />
        ))}
      </CardGrid>
      {registry.more ? (
        <div className="load-more">
          <button
            type="button"
            disabled={registry.loadingMore}
            onClick={() => {
              post({ type: 'moreRegistry' });
            }}
          >
            {registry.loadingMore ? 'Loading…' : 'Show more'}
          </button>
        </div>
      ) : null}
    </>
  );
}

function InstallNoticeLine(props: { readonly registry: RegistryState }): ReactElement | null {
  const { notice } = props.registry;
  if (notice === null) {
    return null;
  }
  return (
    <Notice ok={notice.ok}>
      <Badge label={notice.ok ? 'Added' : 'Not added'} tone={notice.ok ? 'good' : 'critical'} />{' '}
      {notice.text}
    </Notice>
  );
}

export function RegistrySection(props: {
  readonly registry: RegistryState;
  /** The agents a server can be added to. Claude Code alone keeps the form as it was. */
  readonly mcpAgents: readonly AgentId[];
}): ReactElement {
  const { registry } = props;
  const post = usePostAction();
  const [query, setQuery] = useState(registry.query ?? '');
  const search = (event: SubmitEvent): void => {
    event.preventDefault();
    post({ type: 'searchRegistry', query });
  };
  return (
    <section className="reg" aria-labelledby="registry-title">
      <h2 id="registry-title" className="section-title">
        Discover MCP servers
      </h2>
      <p className="muted reg-lede">
        From the public MCP registry. Install adds a server for every project, the same as{' '}
        <InstallSameAs several={props.mcpAgents.length > 1} />. Packages run on this machine with
        your permissions, so add only servers you trust.
      </p>
      <form className="search-bar" role="search" onSubmit={search}>
        <input
          type="search"
          aria-label="Server name"
          value={query}
          placeholder="Search by name: github, sentry, postgres…"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <button type="submit" className="primary" disabled={registry.searching}>
          {registry.searching ? 'Searching…' : 'Search'}
        </button>
        <button
          type="button"
          disabled={registry.searching}
          onClick={() => {
            setQuery('');
            post({ type: 'searchRegistry', query: '' });
          }}
        >
          Browse all
        </button>
      </form>
      <InstallNoticeLine registry={registry} />
      {registry.error === null ? null : (
        <p className="error-text" role="alert">
          {registry.error}
        </p>
      )}
      <Results registry={registry} mcpAgents={props.mcpAgents} />
    </section>
  );
}
