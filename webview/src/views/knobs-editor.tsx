// One knob in the catalog: its summary line, and when expanded, the full
// layer chain and an editor that sets the value at a chosen layer.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { EffectiveValue, KnobDefinition } from '../../../src/shared/model.js';
import { Badge } from '../components/badge.js';
import { formatValue } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import type { EditableLayer } from './knobs-values.js';
import {
  APPLIES_LABELS,
  displayValue,
  EDITABLE_LAYERS,
  isEditableLayer,
  parseKnobInput,
  startText,
} from './knobs-values.js';

function ValueControl(props: {
  readonly definition: KnobDefinition;
  readonly text: string;
  readonly onChange: (text: string) => void;
}): ReactElement {
  const { definition, text, onChange } = props;
  const label = `Value for ${definition.key}`;
  switch (definition.valueType) {
    case 'boolean':
    case 'enum': {
      const options = definition.valueType === 'boolean' ? ['true', 'false'] : definition.allowed;
      return (
        <select
          aria-label={label}
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    case 'json': {
      return (
        <textarea
          aria-label={label}
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    }
    case 'number':
    case 'string':
    case 'string[]': {
      return (
        <input
          aria-label={label}
          type={definition.valueType === 'number' ? 'number' : 'text'}
          placeholder={definition.valueType === 'string[]' ? 'a, b, c' : undefined}
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    }
  }
}

function KnobEditor(props: {
  readonly definition: KnobDefinition;
  readonly effective: EffectiveValue | undefined;
}): ReactElement {
  const { definition, effective } = props;
  const post = usePostAction();
  const [layer, setLayer] = useState<EditableLayer>('user');
  const [text, setText] = useState(() => startText(definition, effective));
  const parsed = parseKnobInput(definition.valueType, text);
  if (definition.managedOnly) {
    return <p className="muted">Read only. Only managed policy can set this key.</p>;
  }
  return (
    <div className="toolbar">
      <label>
        Layer
        <select
          value={layer}
          onChange={(event) => {
            const next = event.target.value;
            if (isEditableLayer(next)) {
              setLayer(next);
            }
          }}
        >
          {EDITABLE_LAYERS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <ValueControl definition={definition} text={text} onChange={setText} />
      {parsed.ok ? (
        <button
          type="button"
          className="primary"
          onClick={() => {
            post({ type: 'setKnob', key: definition.key, value: parsed.value, layer });
          }}
        >
          Save
        </button>
      ) : (
        <>
          <button type="button" className="primary" disabled>
            Save
          </button>
          <span className="error-text" role="alert">
            {parsed.error}
          </span>
        </>
      )}
    </div>
  );
}

function ChainFile(props: { readonly file: string | null }): ReactElement {
  const post = usePostAction();
  const { file } = props;
  if (file === null) {
    return <span className="muted">none</span>;
  }
  return (
    <button
      type="button"
      className="link-button"
      onClick={() => {
        post({ type: 'openFile', path: file });
      }}
    >
      {file}
    </button>
  );
}

function KnobChain(props: { readonly effective: EffectiveValue | undefined }): ReactElement {
  const chain = props.effective?.chain ?? [];
  if (chain.length === 0) {
    return <p className="muted">No layer sets this key. The default applies.</p>;
  }
  return (
    <table className="grid">
      <caption className="visually-hidden">Layers that set this key</caption>
      <thead>
        <tr>
          <th scope="col">Layer</th>
          <th scope="col">Value</th>
          <th scope="col">File</th>
        </tr>
      </thead>
      <tbody>
        {chain.map((entry) => (
          <tr key={entry.layer}>
            <td>{entry.layer}</td>
            <td className="mono wrap">{formatValue(entry.value)}</td>
            <td>
              <ChainFile file={entry.file} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function KnobRow(props: {
  readonly definition: KnobDefinition;
  readonly effective: EffectiveValue | undefined;
  readonly expanded: boolean;
  readonly onToggle: (key: string) => void;
}): ReactElement {
  const { definition, effective, expanded, onToggle } = props;
  return (
    <li className="section">
      <div className="toolbar">
        <button
          type="button"
          className="twisty"
          aria-expanded={expanded}
          aria-label={`Details for ${definition.key}`}
          onClick={() => {
            onToggle(definition.key);
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <code>{definition.key}</code>
        <Badge label={definition.kind} />
        <span className="mono">{displayValue(definition, effective)}</span>
        {effective === undefined ? null : <Badge label={effective.layer} tone="info" />}
        <Badge label={`applies ${APPLIES_LABELS[definition.appliesAt]}`} />
        {definition.managedOnly ? <Badge label="managed only" tone="warning" /> : null}
      </div>
      <p className="muted">{definition.description}</p>
      {expanded ? (
        <div>
          <KnobChain effective={effective} />
          <KnobEditor definition={definition} effective={effective} />
        </div>
      ) : null}
    </li>
  );
}
