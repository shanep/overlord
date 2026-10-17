// The launch form, in the order you fill it in: what to do, which profiles,
// where, and the optional limits. Each field says what it is for, and the
// line beside Launch says what will happen or what is still missing.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { LauncherState } from '../../../src/shared/protocol.js';
import { isString, isStringArray } from '../guards.js';
import { usePersistentState, usePostAction } from '../vscode-context.js';

import { buildSpecs, launchSummary, parseBudget, runCountLabel } from './launcher-values.js';

function DraftPicker(props: {
  readonly drafts: LauncherState['drafts'];
  readonly onPick: (draft: LauncherState['drafts'][number]) => void;
}): ReactElement | null {
  const { drafts, onPick } = props;
  if (drafts.length === 0) {
    return null;
  }
  return (
    <div className="launch-draft">
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
    </div>
  );
}

function ProfilePicker(props: {
  readonly profiles: LauncherState['profiles'];
  readonly checked: readonly string[];
  readonly onChange: (checked: readonly string[]) => void;
}): ReactElement {
  const { profiles, checked, onChange } = props;
  const post = usePostAction();
  if (profiles.length === 0) {
    return (
      <div className="toolbar">
        <span className="muted">
          No profiles yet, so you get 1 run with your usual settings. Profiles live in Knobs.
        </span>
        <button
          type="button"
          onClick={() => {
            post({ type: 'openView', view: 'knobs' });
          }}
        >
          Make a profile
        </button>
      </div>
    );
  }
  return (
    <fieldset className="chips launch-profiles" aria-describedby="launch-profiles-hint">
      <legend className="visually-hidden">Profiles</legend>
      {profiles.map((profile) => (
        <label key={profile.id} className="pill-check">
          <input
            type="checkbox"
            checked={checked.includes(profile.id)}
            onChange={(event) => {
              onChange(
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
  );
}

export function LaunchFormView(props: {
  readonly profiles: LauncherState['profiles'];
  readonly drafts: LauncherState['drafts'];
  readonly defaultFolder: string;
}): ReactElement {
  const { profiles, drafts, defaultFolder } = props;
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
  const maxBudgetUsd = budget.ok ? budget.value : null;
  const specs = buildSpecs({ prompt, label, cwd, worktree, maxBudgetUsd }, selected);
  const canLaunch = prompt.trim() !== '' && budget.ok;
  const summary = launchSummary({
    prompt,
    folder: cwd.trim() === '' ? defaultFolder : cwd.trim(),
    worktree,
    maxBudgetUsd,
    profileNames: selected.map((profile) => profile.name),
  });
  return (
    <section className="card launch-card" aria-labelledby="launch-heading">
      <h2 id="launch-heading" className="launch-title">
        New run
      </h2>

      <h3 className="launch-step">1. What should it do?</h3>
      <DraftPicker
        drafts={drafts}
        onPick={(draft) => {
          setPrompt(draft.prompt);
          setLabel(draft.label);
        }}
      />
      <label className="field">
        <span>Prompt</span>
        <textarea
          value={prompt}
          aria-describedby="launch-prompt-hint"
          placeholder="For example: Add a test for the date parser and make sure npm test passes."
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
        />
      </label>
      <p id="launch-prompt-hint" className="hint">
        A run works on its own until it finishes, so say what done looks like.
      </p>

      <h3 className="launch-step">2. Which profiles?</h3>
      <p id="launch-profiles-hint" className="hint">
        A profile is a saved model and settings. Each one you tick runs the same prompt, so you can
        compare them side by side. Tick none for 1 run with your usual settings.
      </p>
      <ProfilePicker profiles={profiles} checked={checked} onChange={setChecked} />

      <h3 className="launch-step">3. Where?</h3>
      <label className="field">
        <span>Folder</span>
        <input
          type="text"
          value={cwd}
          placeholder={defaultFolder}
          aria-describedby="launch-folder-hint"
          onChange={(event) => {
            setCwd(event.target.value);
          }}
        />
      </label>
      <p id="launch-folder-hint" className="hint">
        Leave it empty to use {defaultFolder}.
      </p>
      <label>
        <input
          type="checkbox"
          checked={worktree}
          aria-describedby="launch-worktree-hint"
          onChange={(event) => {
            setWorktree(event.target.checked);
          }}
        />
        Own git worktree
      </label>
      <p id="launch-worktree-hint" className="hint">
        Each run gets its own copy of the repository, so runs never change your files or each
        other&apos;s. When a run finishes, land or discard its copy under Worktrees.
      </p>

      <h3 className="launch-step">4. Name and limit (optional)</h3>
      <div className="launch-limits">
        <label>
          Label
          <input
            type="text"
            value={label}
            placeholder="first line of the prompt"
            aria-describedby="launch-label-hint"
            onChange={(event) => {
              setLabel(event.target.value);
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
            aria-describedby="launch-budget-hint"
            onChange={(event) => {
              setBudgetText(event.target.value);
            }}
          />
        </label>
      </div>
      <p className="hint">
        <span id="launch-label-hint">The label names the run in the table below.</span>{' '}
        <span id="launch-budget-hint">A budget stops a run once it has spent that much.</span>
      </p>

      <div className="form-actions launch-actions">
        <span id="launch-summary" className="muted">
          {summary}
        </span>
        {budget.ok ? null : (
          <span className="error-text" role="alert">
            {budget.error}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          disabled={!canLaunch}
          aria-describedby="launch-summary"
          onClick={() => {
            post({ type: 'launch', specs });
          }}
        >
          Launch {runCountLabel(specs.length)}
        </button>
      </div>
    </section>
  );
}
