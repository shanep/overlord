// One knob in the catalog: its summary line, and when expanded, the full
// layer chain with a way to remove the key from a layer, and an editor that
// sets the value at a chosen layer. CLI flags get the profile editor instead.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { EffectiveValue, KnobDefinition, LaunchProfile } from '../../../src/shared/model.js';
import { Badge } from '../components/badge.js';
import { formatValue } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { FlagEditor } from './knobs-flags.js';
import { ValueControl } from './knobs-value-control.js';
import type { EditableLayer, ParseResult } from './knobs-values.js';
import {
  APPLIES_LABELS,
  defaultLayer,
  displayValue,
  EDITABLE_LAYERS,
  isEditableLayer,
  isRetired,
  parseKnobValue,
  startTextAt,
} from './knobs-values.js';

function SaveButton(props: {
  readonly parsed: ParseResult;
  readonly onSave: (value: unknown) => void;
}): ReactElement {
  const { parsed } = props;
  if (!parsed.ok) {
    return (
      <>
        <button type="button" className="primary" disabled>
          Save
        </button>
        <span className="error-text" role="alert">
          {parsed.error}
        </span>
      </>
    );
  }
  return (
    <button
      type="button"
      className="primary"
      onClick={() => {
        props.onSave(parsed.value);
      }}
    >
      Save
    </button>
  );
}

function KnobEditor(props: {
  readonly definition: KnobDefinition;
  readonly effective: EffectiveValue | undefined;
}): ReactElement {
  const { definition, effective } = props;
  const post = usePostAction();
  const [layer, setLayer] = useState<EditableLayer>(() => defaultLayer(effective));
  const [text, setText] = useState(() => startTextAt(definition, effective, layer));
  const parsed = parseKnobValue(definition, text);
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
              setText(startTextAt(definition, effective, next));
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
      <SaveButton
        parsed={parsed}
        onSave={(value) => {
          post({ type: 'setKnob', key: definition.key, value, layer });
        }}
      />
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

function RemoveButton(props: {
  readonly keyName: string;
  readonly layer: string;
  readonly onRemove: (layer: EditableLayer) => void;
}): ReactElement | null {
  const { layer } = props;
  if (!isEditableLayer(layer)) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label={`Remove ${props.keyName} from ${layer}`}
      onClick={() => {
        props.onRemove(layer);
      }}
    >
      Remove
    </button>
  );
}

function KnobChain(props: {
  readonly definition: KnobDefinition;
  readonly effective: EffectiveValue | undefined;
}): ReactElement {
  const { definition } = props;
  const post = usePostAction();
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
          <th scope="col">
            <span className="visually-hidden">Actions</span>
          </th>
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
            <td>
              <RemoveButton
                keyName={definition.key}
                layer={entry.layer}
                onRemove={(layer) => {
                  post({ type: 'setKnob', key: definition.key, value: null, layer });
                }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DocumentationButton(props: { readonly definition: KnobDefinition }): ReactElement | null {
  const post = usePostAction();
  const { definition } = props;
  if (definition.docUrl === '') {
    return null;
  }
  return (
    <button
      type="button"
      className="link-button"
      aria-label={`Docs for ${definition.key}`}
      onClick={() => {
        post({ type: 'openKnobDocs', key: definition.key, kind: definition.kind });
      }}
    >
      Docs
    </button>
  );
}

function RowValue(props: {
  readonly definition: KnobDefinition;
  readonly effective: EffectiveValue | undefined;
  readonly inProfiles: readonly string[];
}): ReactElement {
  const { definition, effective, inProfiles } = props;
  if (definition.kind !== 'flag') {
    return (
      <>
        <span className="mono wrap">{displayValue(definition, effective)}</span>
        {effective === undefined ? null : <Badge label={effective.layer} tone="info" />}
      </>
    );
  }
  return inProfiles.length === 0 ? (
    <span className="muted">not in a profile</span>
  ) : (
    <Badge label={`in ${inProfiles.join(', ')}`} tone="info" />
  );
}

export function KnobRow(props: {
  readonly definition: KnobDefinition;
  readonly effective: EffectiveValue | undefined;
  readonly profiles: readonly LaunchProfile[];
  /** Names of the profiles that pass this knob, for CLI flags. */
  readonly inProfiles: readonly string[];
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
        <RowValue definition={definition} effective={effective} inProfiles={props.inProfiles} />
        <Badge label={`applies ${APPLIES_LABELS[definition.appliesAt]}`} />
        {definition.managedOnly ? <Badge label="managed only" tone="warning" /> : null}
        {isRetired(definition) ? <Badge label="removed" tone="warning" /> : null}
      </div>
      <p className="muted">{definition.description}</p>
      {expanded ? (
        <div>
          <DocumentationButton definition={definition} />
          {definition.kind === 'flag' ? (
            <FlagEditor definition={definition} profiles={props.profiles} />
          ) : (
            <>
              <KnobChain definition={definition} effective={effective} />
              <KnobEditor definition={definition} effective={effective} />
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}
