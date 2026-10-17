// Launch profiles: named sets of model, effort, permission mode, env vars
// and extra CLI args that the launcher uses.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { AgentId, AgentInfo, ModeOption } from '../../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../../src/shared/agents.js';
import type { LaunchProfile } from '../../../src/shared/model.js';
import { findAgent, offeredAgents, useAgents } from '../agents.js';
import { CLAUDE_FALLBACK } from '../claude-fallback.js';
import { usePostAction } from '../vscode-context.js';

import { formatEnv, nullIfEmpty, parseArgs, parseEnv } from './knobs-values.js';

interface ProfileDraft {
  /** The form shows a pick only when there is more than one agent to choose. */
  readonly agent: string;
  /** Kept from the profile so a save does not change it. The form does not show it. */
  readonly backend: string;
  readonly name: string;
  readonly model: string;
  readonly effort: string;
  readonly mode: string;
  readonly env: string;
  readonly args: string;
}

export function toDraft(profile: LaunchProfile): ProfileDraft {
  return {
    agent: profile.agent,
    backend: profile.backend ?? '',
    name: profile.name,
    model: profile.model ?? '',
    effort: profile.effort ?? '',
    mode: profile.permissionMode ?? '',
    env: formatEnv(profile.env),
    args: profile.extraArgs.join(' '),
  };
}

/** The profile the form holds. A mode the agent does not have is dropped. */
export function fromDraft(
  id: string,
  draft: ProfileDraft,
  modes: readonly ModeOption[] = CLAUDE_FALLBACK.permissionModes,
): LaunchProfile {
  return {
    id,
    name: draft.name.trim(),
    agent: draft.agent,
    ...(draft.backend === '' ? {} : { backend: draft.backend }),
    model: nullIfEmpty(draft.model),
    effort: nullIfEmpty(draft.effort),
    permissionMode: modes.some((mode) => mode.id === draft.mode) ? draft.mode : null,
    env: parseEnv(draft.env),
    extraArgs: parseArgs(draft.args),
  };
}

export function blankProfile(id: string, agent: AgentId = CLAUDE_CODE): LaunchProfile {
  return {
    id,
    name: '',
    agent,
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

/** The agent pick, shown when there is more than one to choose or the profile is for another agent. */
function AgentPick(props: {
  readonly offered: readonly AgentInfo[];
  readonly agent: AgentInfo;
  readonly onChange: (agent: AgentInfo) => void;
}): ReactElement | null {
  const { offered, agent } = props;
  const choices = offered.some((item) => item.id === agent.id) ? offered : [...offered, agent];
  if (choices.length < 2) {
    return null;
  }
  return (
    <label className="field">
      <span>Agent</span>
      <select
        value={agent.id}
        onChange={(event) => {
          const picked = choices.find((item) => item.id === event.target.value);
          if (picked !== undefined) {
            props.onChange(picked);
          }
        }}
      >
        {choices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProfileForm(props: {
  readonly profile: LaunchProfile;
  /** False for a new profile that only lives in this form so far. */
  readonly saved: boolean;
}): ReactElement {
  const { profile } = props;
  const post = usePostAction();
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(profile));
  const agents = useAgents();
  const agent = findAgent(agents, draft.agent);
  const modes = agent.permissionModes;
  // Effort is free text, but only for an agent that has effort levels.
  const fields = TEXT_FIELDS.filter(
    ({ field }) => field !== 'effort' || agent.effortLevels.length > 0,
  );
  const title = profile.name === '' ? 'New profile' : profile.name;
  return (
    <fieldset className="card profile-card">
      <legend className="card-title">{title}</legend>
      <div className="form-grid">
        <AgentPick
          offered={offeredAgents(agents)}
          agent={agent}
          onChange={(picked) => {
            // Another agent's modes and levels mean something else, so they start over.
            setDraft({ ...draft, agent: picked.id, effort: '', mode: '' });
          }}
        />
        {fields.map(({ field, label }) => (
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
        {modes.length === 0 ? null : (
          <label className="field">
            <span>Permission mode</span>
            <select
              value={draft.mode}
              onChange={(event) => {
                setDraft({ ...draft, mode: event.target.value });
              }}
            >
              <option value="">none</option>
              {modes.map((mode) => (
                <option key={mode.id} value={mode.id} title={mode.label}>
                  {mode.id}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="field profile-env">
        <span>Env vars, one KEY=VALUE per line</span>
        <textarea
          value={draft.env}
          onChange={(event) => {
            setDraft({ ...draft, env: event.target.value });
          }}
        />
      </label>
      <div className="form-actions">
        {props.saved ? (
          <button
            type="button"
            className="danger"
            onClick={() => {
              post({ type: 'deleteProfile', profileId: profile.id });
            }}
          >
            Delete profile
          </button>
        ) : null}
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          disabled={draft.name.trim() === ''}
          onClick={() => {
            post({ type: 'saveProfile', profile: fromDraft(profile.id, draft, modes) });
          }}
        >
          Save profile
        </button>
      </div>
    </fieldset>
  );
}

export function ProfilesEditor(props: {
  readonly profiles: readonly LaunchProfile[];
  /** The agent a new profile starts with. Unset is Claude Code. */
  readonly agent?: AgentId;
}): ReactElement {
  const [added, setAdded] = useState<readonly LaunchProfile[]>([]);
  const known = new Set(props.profiles.map((profile) => profile.id));
  const pending = added.filter((profile) => !known.has(profile.id));
  return (
    <section className="section" aria-labelledby="profiles-heading">
      <div className="list-bar">
        <h2 id="profiles-heading">Launch profiles</h2>
        <span className="spacer" />
        <button
          type="button"
          onClick={() => {
            setAdded([...added, blankProfile(`profile-${Date.now().toString(36)}`, props.agent)]);
          }}
        >
          New profile
        </button>
      </div>
      {props.profiles.length + pending.length === 0 ? (
        <p className="muted">No profiles yet.</p>
      ) : null}
      <p className="muted">
        A profile is a model, effort, permission mode, env vars and extra args the Launcher can
        start a run with.
      </p>
      <div className="profile-grid">
        {[...props.profiles, ...pending].map((profile) => (
          <ProfileForm key={profile.id} profile={profile} saved={known.has(profile.id)} />
        ))}
      </div>
    </section>
  );
}
