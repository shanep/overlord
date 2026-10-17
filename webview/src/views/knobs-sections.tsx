// The parts of the Knobs keys tab: the settings files behind the layers, one
// folding section per area, and the keys the docs do not list with a form to
// add your own env var.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type {
  EffectiveValue,
  LaunchProfile,
  SettingsFileSummary,
} from '../../../src/shared/model.js';
import { Badge } from '../components/badge.js';
import { Card, CardGrid, StatusDot } from '../components/card.js';
import { plural } from '../format.js';
import type { Tone } from '../labels.js';
import { usePostAction } from '../vscode-context.js';

import { KnobRow } from './knobs-editor.js';
import { unlistedDefinition } from './knobs-match.js';
import type { AreaGroup, EditableLayer } from './knobs-values.js';
import { EDITABLE_LAYERS, isEditableLayer } from './knobs-values.js';

function fileTone(file: SettingsFileSummary): Tone {
  if (file.error !== null) {
    return 'critical';
  }
  return file.exists ? 'good' : 'neutral';
}

export function SettingsFiles(props: {
  readonly files: readonly SettingsFileSummary[];
}): ReactElement {
  const post = usePostAction();
  return (
    <section className="section" aria-labelledby="files-heading">
      <h2 id="files-heading" className="section-title">
        Settings files <span className="count">{String(props.files.length)}</span>
      </h2>
      <p className="muted">
        Highest precedence first. Saving a key below writes the layer you pick and keeps the old
        file as .bak.
      </p>
      <CardGrid label="Settings files Claude Code reads">
        {props.files.map((file) => (
          <Card key={file.layer}>
            <div className="card-head">
              <StatusDot tone={fileTone(file)} />
              <span className="card-title">{file.layer}</span>
              <span className="chip">{plural(file.keys, 'key')}</span>
            </div>
            <div className="knob-file">
              {file.exists ? (
                <button
                  type="button"
                  className="link-button"
                  title={file.file}
                  onClick={() => {
                    post({ type: 'openFile', path: file.file });
                  }}
                >
                  {file.file}
                </button>
              ) : (
                <span className="muted">{file.file} (not created yet)</span>
              )}
            </div>
            {file.error === null ? null : (
              <p className="error-text" role="alert">
                {file.error}
              </p>
            )}
          </Card>
        ))}
      </CardGrid>
    </section>
  );
}

export interface RowProps {
  readonly profiles: readonly LaunchProfile[];
  readonly expanded: readonly string[];
  readonly onToggle: (key: string) => void;
}

export function AreaSection(props: {
  readonly group: AreaGroup;
  readonly open: boolean;
  readonly onToggleArea: (area: string) => void;
  readonly rows: RowProps;
}): ReactElement {
  const { group, open, rows } = props;
  const id = `area-${group.area}`;
  return (
    <section className="card knob-area" aria-labelledby={id}>
      <div className="card-head">
        <h2 id={id} className="area-heading">
          <button
            type="button"
            className="area-toggle"
            aria-expanded={open}
            onClick={() => {
              props.onToggleArea(group.area);
            }}
          >
            <span aria-hidden="true">{open ? '▾ ' : '▸ '}</span>
            {group.title}
          </button>
        </h2>
        <span className="chip">{plural(group.entries.length, 'key')}</span>
        {group.setCount === 0 ? null : (
          <Badge label={`${String(group.setCount)} set`} tone="info" />
        )}
      </div>
      {group.summary === '' ? null : <p className="card-text knob-summary">{group.summary}</p>}
      {open ? (
        <ul className="knob-list">
          {group.entries.map((entry) => (
            <KnobRow
              key={`${entry.definition.kind}:${entry.definition.key}`}
              definition={entry.definition}
              effective={entry.effective}
              profiles={rows.profiles}
              inProfiles={entry.profiles}
              expanded={rows.expanded.includes(entry.definition.key)}
              onToggle={rows.onToggle}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const ENV_NAME = /^[A-Za-z_]\w*$/u;

function AddEnvVariable(): ReactElement {
  const post = usePostAction();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [layer, setLayer] = useState<EditableLayer>('user');
  const trimmed = name.trim();
  const valid = ENV_NAME.test(trimmed);
  return (
    <div className="knob-add">
      <label>
        Name
        <input
          type="text"
          value={name}
          placeholder="MY_VAR"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <label>
        Value
        <input
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </label>
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
      <button
        type="button"
        className="primary"
        disabled={!valid}
        onClick={() => {
          post({ type: 'setKnob', key: `env.${trimmed}`, value, layer });
          setName('');
          setValue('');
        }}
      >
        Add env var
      </button>
      {trimmed === '' || valid ? null : (
        <span className="error-text" role="alert">
          Use letters, digits and underscores, not starting with a digit.
        </span>
      )}
    </div>
  );
}

export function UnlistedSection(props: {
  readonly values: readonly EffectiveValue[];
  readonly rows: RowProps;
}): ReactElement {
  const { values, rows } = props;
  return (
    <section className="card knob-area" aria-labelledby="unlisted-heading">
      <div className="card-head">
        <h2 id="unlisted-heading" className="area-heading">
          Not in the docs
        </h2>
        <span className="chip">{plural(values.length, 'key')}</span>
      </div>
      <p className="card-text knob-summary">
        Keys your settings set that the docs catalog does not list, such as your own env vars. Add
        one here and every session gets it.
      </p>
      <AddEnvVariable />
      {values.length === 0 ? null : (
        <ul className="knob-list">
          {values.map((value) => (
            <KnobRow
              key={value.key}
              definition={unlistedDefinition(value)}
              effective={value}
              profiles={rows.profiles}
              inProfiles={[]}
              expanded={rows.expanded.includes(value.key)}
              onToggle={rows.onToggle}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
