// The editor for a CLI flag. A flag cannot live in a settings file, so this
// adds it to or removes it from the launch profiles Overlord starts sessions with.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { KnobDefinition, LaunchProfile } from '../../../src/shared/model.js';
import { usePostAction } from '../vscode-context.js';

import { flagInProfile, withFlag, withoutFlag } from './knobs-match.js';
import { ValueControl } from './knobs-value-control.js';
import { startText } from './knobs-values.js';

/** A flag's value as profile text: null for a bare switch. */
function flagArgument(definition: KnobDefinition, text: string): string | null {
  return definition.valueType === 'boolean' || text.trim() === '' ? null : text.trim();
}

function FlagProfileRow(props: {
  readonly definition: KnobDefinition;
  readonly profile: LaunchProfile;
  readonly text: string;
}): ReactElement {
  const { definition, profile, text } = props;
  const post = usePostAction();
  const current = flagInProfile(profile, definition.key);
  const save = (extraArgs: readonly string[]): void => {
    post({ type: 'saveProfile', profile: { ...profile, extraArgs } });
  };
  return (
    <tr>
      <td>{profile.name}</td>
      <td className="mono wrap">
        {current === undefined ? <span className="muted">not passed</span> : (current ?? 'on')}
      </td>
      <td>
        <button
          type="button"
          aria-label={`${current === undefined ? 'Add' : 'Update'} ${definition.key} in ${profile.name}`}
          onClick={() => {
            save(withFlag(profile.extraArgs, definition.key, flagArgument(definition, text)));
          }}
        >
          {current === undefined ? 'Add' : 'Update'}
        </button>
        {current === undefined ? null : (
          <>
            {' '}
            <button
              type="button"
              aria-label={`Remove ${definition.key} from ${profile.name}`}
              onClick={() => {
                save(withoutFlag(profile.extraArgs, definition.key));
              }}
            >
              Remove
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

export function FlagEditor(props: {
  readonly definition: KnobDefinition;
  readonly profiles: readonly LaunchProfile[];
}): ReactElement {
  const { definition, profiles } = props;
  const [text, setText] = useState(() => startText(definition));
  if (profiles.length === 0) {
    return (
      <p className="muted">
        A CLI flag cannot go in a settings file. Make a launch profile in the Launch profiles tab,
        then add the flag to it here.
      </p>
    );
  }
  return (
    <div>
      <p className="muted">
        A CLI flag cannot go in a settings file. Overlord passes it to the sessions a launch profile
        starts.
      </p>
      {definition.valueType === 'boolean' ? null : (
        <div className="toolbar">
          <ValueControl definition={definition} text={text} onChange={setText} />
        </div>
      )}
      <table className="grid">
        <caption className="visually-hidden">Launch profiles that pass {definition.key}</caption>
        <thead>
          <tr>
            <th scope="col">Profile</th>
            <th scope="col">Value</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => (
            <FlagProfileRow
              key={profile.id}
              definition={definition}
              profile={profile}
              text={text}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
