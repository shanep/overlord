// The launch form: prompt, drafts, profile matrix, worktree and budget.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { LauncherState } from '../../../src/shared/protocol.js';
import { isString, isStringArray } from '../guards.js';
import { usePersistentState, usePostAction } from '../vscode-context.js';

import { buildSpecs, parseBudget, runCountLabel } from './launcher-values.js';

function DraftPicker(props: {
  readonly drafts: LauncherState['drafts'];
  readonly onPick: (draft: LauncherState['drafts'][number]) => void;
}): ReactElement | null {
  const { drafts, onPick } = props;
  if (drafts.length === 0) {
    return null;
  }
  return (
    <label>
      Load draft
      <select
        value=""
        onChange={(event) => {
          const draft = drafts.find((item) => item.id === event.target.value);
          if (draft !== undefined) {
            onPick(draft);
          }
        }}
      >
        <option value="">Choose a draft</option>
        {drafts.map((draft) => (
          <option key={draft.id} value={draft.id}>
            {draft.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function LaunchFormView(props: {
  readonly profiles: LauncherState['profiles'];
  readonly drafts: LauncherState['drafts'];
}): ReactElement {
  const { profiles, drafts } = props;
  const post = usePostAction();
  const [prompt, setPrompt] = usePersistentState('launcher.prompt', '', isString);
  const [label, setLabel] = usePersistentState('launcher.label', '', isString);
  const [cwd, setCwd] = usePersistentState('launcher.cwd', '', isString);
  const [checked, setChecked] = usePersistentState<readonly string[]>(
    'launcher.profiles',
    [],
    isStringArray,
  );
  const [worktree, setWorktree] = useState(true);
  const [budgetText, setBudgetText] = useState('');
  const budget = parseBudget(budgetText);
  const selected = profiles.filter((profile) => checked.includes(profile.id));
  const specs = buildSpecs(
    { prompt, label, cwd, worktree, maxBudgetUsd: budget.ok ? budget.value : null },
    selected,
  );
  const canLaunch = prompt.trim() !== '' && budget.ok;
  return (
    <section className="section" aria-labelledby="launch-heading">
      <h2 id="launch-heading">New run</h2>
      <div className="toolbar">
        <DraftPicker
          drafts={drafts}
          onPick={(draft) => {
            setPrompt(draft.prompt);
            setLabel(draft.label);
          }}
        />
      </div>
      <label className="field">
        <span>Prompt</span>
        <textarea
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
        />
      </label>
      <div className="toolbar">
        <label>
          Label
          <input
            type="text"
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />
        </label>
        <label>
          Folder
          <input
            type="text"
            value={cwd}
            placeholder="workspace folder"
            onChange={(event) => {
              setCwd(event.target.value);
            }}
          />
        </label>
        <label>
          Budget (USD)
          <input
            type="number"
            min="0"
            step="0.5"
            value={budgetText}
            placeholder="none"
            onChange={(event) => {
              setBudgetText(event.target.value);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={worktree}
            onChange={(event) => {
              setWorktree(event.target.checked);
            }}
          />
          Own git worktree
        </label>
      </div>
      <fieldset className="chips">
        <legend>Profiles (pick several for a matrix run)</legend>
        {profiles.length === 0 ? <span className="muted">No profiles yet.</span> : null}
        {profiles.map((profile) => (
          <label key={profile.id}>
            <input
              type="checkbox"
              checked={checked.includes(profile.id)}
              onChange={(event) => {
                setChecked(
                  event.target.checked
                    ? [...checked, profile.id]
                    : checked.filter((id) => id !== profile.id),
                );
              }}
            />
            {profile.name}
          </label>
        ))}
      </fieldset>
      <div className="toolbar">
        <button
          type="button"
          className="primary"
          disabled={!canLaunch}
          onClick={() => {
            post({ type: 'launch', specs });
          }}
        >
          Launch {runCountLabel(specs.length)}
        </button>
        {budget.ok ? null : (
          <span className="error-text" role="alert">
            {budget.error}
          </span>
        )}
      </div>
    </section>
  );
}
