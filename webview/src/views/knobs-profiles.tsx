// Launch profiles: named sets of model, effort, permission mode, env vars
// and extra CLI args that the launcher uses.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { LaunchProfile } from '../../../src/shared/model.js';
import { usePostAction } from '../vscode-context.js';

import {
  formatEnv,
  isPermissionMode,
  nullIfEmpty,
  parseArgs,
  parseEnv,
  PERMISSION_MODES,
} from './knobs-values.js';

interface ProfileDraft {
  readonly name: string;
  readonly model: string;
  readonly effort: string;
  readonly mode: string;
  readonly env: string;
  readonly args: string;
}

export function toDraft(profile: LaunchProfile): ProfileDraft {
  return {
    name: profile.name,
    model: profile.model ?? '',
    effort: profile.effort ?? '',
    mode: profile.permissionMode ?? '',
    env: formatEnv(profile.env),
    args: profile.extraArgs.join(' '),
  };
}

export function fromDraft(id: string, draft: ProfileDraft): LaunchProfile {
  return {
    id,
    name: draft.name.trim(),
    model: nullIfEmpty(draft.model),
    effort: nullIfEmpty(draft.effort),
    permissionMode: isPermissionMode(draft.mode) ? draft.mode : null,
    env: parseEnv(draft.env),
    extraArgs: parseArgs(draft.args),
  };
}

export function blankProfile(id: string): LaunchProfile {
  return {
    id,
    name: '',
    model: null,
    effort: null,
    permissionMode: null,
    env: {},
    extraArgs: [],
  };
}

type TextField = 'name' | 'model' | 'effort' | 'args';

const TEXT_FIELDS: readonly { readonly field: TextField; readonly label: string }[] = [
  { field: 'name', label: 'Name' },
  { field: 'model', label: 'Model' },
  { field: 'effort', label: 'Effort' },
  { field: 'args', label: 'Extra args' },
];

function ProfileForm(props: { readonly profile: LaunchProfile }): ReactElement {
  const { profile } = props;
  const post = usePostAction();
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(profile));
  const title = profile.name === '' ? 'New profile' : profile.name;
  return (
    <fieldset className="section">
      <legend>{title}</legend>
      {TEXT_FIELDS.map(({ field, label }) => (
        <label key={field} className="field">
          <span>{label}</span>
          <input
            type="text"
            value={draft[field]}
            onChange={(event) => {
              setDraft({ ...draft, [field]: event.target.value });
            }}
          />
        </label>
      ))}
      <label className="field">
        <span>Permission mode</span>
        <select
          value={draft.mode}
          onChange={(event) => {
            setDraft({ ...draft, mode: event.target.value });
          }}
        >
          <option value="">none</option>
          {PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Env vars, one KEY=VALUE per line</span>
        <textarea
          value={draft.env}
          onChange={(event) => {
            setDraft({ ...draft, env: event.target.value });
          }}
        />
      </label>
      <button
        type="button"
        className="primary"
        disabled={draft.name.trim() === ''}
        onClick={() => {
          post({ type: 'saveProfile', profile: fromDraft(profile.id, draft) });
        }}
      >
        Save profile
      </button>
    </fieldset>
  );
}

export function ProfilesEditor(props: {
  readonly profiles: readonly LaunchProfile[];
}): ReactElement {
  const [added, setAdded] = useState<readonly LaunchProfile[]>([]);
  const known = new Set(props.profiles.map((profile) => profile.id));
  const pending = added.filter((profile) => !known.has(profile.id));
  return (
    <section className="section" aria-labelledby="profiles-heading">
      <div className="toolbar">
        <h2 id="profiles-heading">Launch profiles</h2>
        <button
          type="button"
          onClick={() => {
            setAdded([...added, blankProfile(`profile-${Date.now().toString(36)}`)]);
          }}
        >
          New profile
        </button>
      </div>
      {props.profiles.length + pending.length === 0 ? (
        <p className="muted">No profiles yet.</p>
      ) : null}
      {[...props.profiles, ...pending].map((profile) => (
        <ProfileForm key={profile.id} profile={profile} />
      ))}
    </section>
  );
}
