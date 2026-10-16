// The input that fits a knob's value type: a select for switches and enums, a
// text area for JSON, and a text or number field for the rest.

import type { ReactElement } from 'react';

import type { KnobDefinition } from '../../../src/shared/model.js';

import { selectOptions } from './knobs-values.js';

export function ValueControl(props: {
  readonly definition: KnobDefinition;
  readonly text: string;
  readonly onChange: (text: string) => void;
}): ReactElement {
  const { definition, text, onChange } = props;
  const label = `Value for ${definition.key}`;
  switch (definition.valueType) {
    case 'boolean':
    case 'enum': {
      return (
        <select
          aria-label={label}
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {selectOptions(definition).map((option) => (
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
