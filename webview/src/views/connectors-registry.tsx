// The registry search under the Connectors table: find a server in the public
// MCP registry, fill in what it needs, and add it to user scope.

import type { ReactElement, SubmitEvent } from 'react';
import { useState } from 'react';

import type {
  InstallInput,
  InstallKind,
  RegistryServer,
  RegistryState,
} from '../../../src/shared/connectors.js';
import { Badge } from '../components/badge.js';
import { usePostAction } from '../vscode-context.js';

const INSTALL_KIND_LABELS: Readonly<Record<InstallKind, string>> = {
  http: 'Remote (HTTP)',
  sse: 'Remote (SSE)',
  npm: 'npm',
  pypi: 'PyPI',
  docker: 'Docker',
};

const NAME_PATTERN = /^[\w-]{1,64}$/u;

function initialValues(inputs: readonly InstallInput[]): Record<string, string> {
  return Object.fromEntries(inputs.map((entry) => [entry.id, entry.initial]));
}

function InputField(props: {
  readonly input: InstallInput;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { input } = props;
  const hintId = `hint-${input.id}`;
  return (
    <>
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
    </>
  );
}

function InstallForm(props: {
  readonly server: RegistryServer;
  readonly installing: boolean;
  readonly onCancel: () => void;
}): ReactElement {
  const { server } = props;
  const post = usePostAction();
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
    post({ type: 'installConnector', server: server.name, option: choice, name, values });
  };
  return (
    <form onSubmit={submit} aria-label={`Install ${server.title}`}>
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
      ) : (
        <p className="hint">
          {INSTALL_KIND_LABELS[option.kind]}: <code>{option.summary}</code>
        </p>
      )}
      <label className="field">
        <span>Name in Claude Code</span>
        <input
          type="text"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        {nameOk ? null : (
          <span className="error-text" role="alert">
            Use only letters, digits, dashes and underscores.
          </span>
        )}
      </label>
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
      <div className="toolbar">
        <button type="submit" disabled={props.installing || missing.length > 0 || !nameOk}>
          {props.installing ? 'Installing…' : 'Install'}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        {missing.length > 0 ? (
          <span className="muted">Fill in {missing.map((entry) => entry.label).join(', ')}.</span>
        ) : null}
      </div>
    </form>
  );
}

function Result(props: {
  readonly server: RegistryServer;
  readonly open: boolean;
  readonly installing: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  const { server } = props;
  const kinds = [...new Set(server.options.map((entry) => entry.kind))];
  return (
    <li>
      <div className="toolbar">
        <strong>{server.title}</strong>
        <span className="muted" title={server.repository ?? undefined}>
          {server.name}
          {server.version === '' ? '' : ` ${server.version}`}
        </span>
        {kinds.map((kind) => (
          <Badge key={kind} label={INSTALL_KIND_LABELS[kind]} tone="info" />
        ))}
        <span className="spacer" />
        {server.options.length === 0 ? (
          <span className="muted">Not installable from here</span>
        ) : (
          <button type="button" disabled={props.busy && !props.open} onClick={props.onToggle}>
            {props.open ? 'Close' : 'Install…'}
          </button>
        )}
      </div>
      {server.description === '' ? null : <p className="hint">{server.description}</p>}
      {props.open ? (
        <InstallForm server={server} installing={props.installing} onCancel={props.onToggle} />
      ) : null}
    </li>
  );
}

function Results(props: { readonly registry: RegistryState }): ReactElement | null {
  const { registry } = props;
  const [open, setOpen] = useState<string | null>(null);
  if (registry.query === null || registry.error !== null) {
    return null;
  }
  if (registry.results.length === 0) {
    return (
      <p className="muted">{registry.searching ? 'Searching…' : 'No servers match that name.'}</p>
    );
  }
  return (
    <>
      <ul className="feed" aria-label="Registry results">
        {registry.results.map((server) => (
          <Result
            key={server.name}
            server={server}
            open={open === server.name}
            installing={registry.installing === server.name}
            busy={registry.installing !== null}
            onToggle={() => {
              setOpen(open === server.name ? null : server.name);
            }}
          />
        ))}
      </ul>
      {registry.more ? (
        <p className="muted">There are more matches. Type more of the name to narrow them down.</p>
      ) : null}
    </>
  );
}

export function RegistrySection(props: { readonly registry: RegistryState }): ReactElement {
  const { registry } = props;
  const post = usePostAction();
  const [query, setQuery] = useState(registry.query ?? '');
  const search = (event: SubmitEvent): void => {
    event.preventDefault();
    post({ type: 'searchRegistry', query });
  };
  return (
    <section className="section" aria-labelledby="registry-title">
      <h2 id="registry-title">Add from the MCP registry</h2>
      <p className="muted">
        Search the public MCP registry by name and add a server for every project, the same as{' '}
        <code>claude mcp add --scope user</code>. A package runs on this machine with your
        permissions, so add only servers you trust. A remote server that needs a sign in shows up
        above with a Sign in button.
      </p>
      <form className="toolbar" role="search" onSubmit={search}>
        <label>
          Server name
          <input
            type="search"
            value={query}
            placeholder="for example github, sentry or postgres"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={registry.searching}>
          {registry.searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {registry.notice === null ? null : (
        <p role={registry.notice.ok ? 'status' : 'alert'}>
          <Badge
            label={registry.notice.ok ? 'Added' : 'Not added'}
            tone={registry.notice.ok ? 'good' : 'critical'}
          />{' '}
          {registry.notice.text}
        </p>
      )}
      {registry.error === null ? null : (
        <p className="error-text" role="alert">
          {registry.error}
        </p>
      )}
      <Results registry={registry} />
    </section>
  );
}
