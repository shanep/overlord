// The launch form, in the order you fill it in: what to do, which profiles,
// where, and the optional limits. Each field says what it is for, and the
// bar under the form says what Launch will do or what is still missing.

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';

import type { LauncherState } from '../../../src/shared/protocol.js';
import { isNumber, isString, isStringArray } from '../guards.js';
import { usePersistentState, usePostAction } from '../vscode-context.js';

import {
  buildSpecs,
  folderGroups,
  launchSummary,
  parseBudget,
  runCountLabel,
} from './launcher-values.js';

/** The Folder option that opens the folder picker instead of choosing a folder. */
const BROWSE = ':browse';

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
        <span className="muted">Load draft</span>
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
      <div className="launch-empty">
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
        <label key={profile.id} className="pill-check" title={profile.model ?? undefined}>
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

function FolderPicker(props: {
  readonly folders: LauncherState['folders'];
  readonly folder: string;
  readonly onChange: (folder: string) => void;
}): ReactElement {
  const { folders, folder, onChange } = props;
  const post = usePostAction();
  return (
    <>
      <label className="field">
        <span>Folder</span>
        <select
          value={folder}
          aria-describedby="launch-folder-hint"
          onChange={(event) => {
            if (event.target.value === BROWSE) {
              post({ type: 'browseLaunchFolder' });
            } else {
              onChange(event.target.value);
            }
          }}
        >
          {folderGroups(folders, folder).map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.folders.map((item) => (
                <option key={item.folder} value={item.folder} title={item.folder}>
                  {item.name}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={BROWSE}>Browse…</option>
        </select>
      </label>
      <p id="launch-folder-hint" className="hint">
        Runs in <span className="mono launch-path">{folder}</span>. Browse picks any other folder.
      </p>
    </>
  );
}

export function LaunchFormView(props: {
  readonly profiles: LauncherState['profiles'];
  readonly drafts: LauncherState['drafts'];
  readonly defaultFolder: string;
  readonly folders: LauncherState['folders'];
  readonly browsed: LauncherState['browsed'];
}): ReactElement {
  const { profiles, drafts, defaultFolder, folders, browsed } = props;
  const post = usePostAction();
  const [prompt, setPrompt] = usePersistentState('launcher.prompt', '', isString);
  const [label, setLabel] = usePersistentState('launcher.label', '', isString);
  const [cwd, setCwd] = usePersistentState('launcher.cwd', '', isString);
  const [browsedAt, setBrowsedAt] = usePersistentState('launcher.browsedAt', 0, isNumber);
  const [checked, setChecked] = usePersistentState<readonly string[]>(
    'launcher.profiles',
    [],
    isStringArray,
  );
  const [worktree, setWorktree] = useState(true);
  const [budgetText, setBudgetText] = useState('');
  // A folder picked with Browse arrives with the next state, so select it once.
  useEffect(() => {
    if (browsed !== null && browsed.at > browsedAt) {
      setCwd(browsed.folder);
      setBrowsedAt(browsed.at);
    }
  }, [browsed, browsedAt, setCwd, setBrowsedAt]);
  const budget = parseBudget(budgetText);
  const selected = profiles.filter((profile) => checked.includes(profile.id));
  const maxBudgetUsd = budget.ok ? budget.value : null;
  const specs = buildSpecs({ prompt, label, cwd, worktree, maxBudgetUsd }, selected);
  const canLaunch = prompt.trim() !== '' && budget.ok;
  const folder = cwd.trim() === '' ? defaultFolder : cwd.trim();
  const summary = launchSummary({
    prompt,
    folder,
    worktree,
    maxBudgetUsd,
    profileNames: selected.map((profile) => profile.name),
  });
  return (
    <section className="card launch-card" aria-labelledby="launch-heading">
      <div className="launch-head">
        <h2 id="launch-heading" className="launch-title">
          New run
        </h2>
        <span className="spacer" />
        <DraftPicker
          drafts={drafts}
          onPick={(draft) => {
            setPrompt(draft.prompt);
            setLabel(draft.label);
          }}
        />
      </div>

      <div className="launch-body">
        <div className="launch-group launch-prompt">
          <h3 className="launch-step">What should it do?</h3>
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
        </div>

        <div className="launch-side">
          <div className="launch-group">
            <h3 className="launch-step">Which profiles?</h3>
            <p id="launch-profiles-hint" className="hint">
              Each profile you pick runs the same prompt with its own model and settings, so you can
              compare them. Pick none for 1 run with your usual settings.
            </p>
            <ProfilePicker profiles={profiles} checked={checked} onChange={setChecked} />
          </div>

          <div className="launch-group">
            <h3 className="launch-step">Where?</h3>
            <FolderPicker folders={folders} folder={folder} onChange={setCwd} />
            <label className="switch">
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
              other&apos;s. Land or discard the copy under Worktrees when it finishes.
            </p>
          </div>

          <div className="launch-group">
            <h3 className="launch-step">Name and limit (optional)</h3>
            <div className="launch-limits">
              <label className="field">
                <span>Label</span>
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
              <label className="field">
                <span>Budget (USD)</span>
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
              <span id="launch-label-hint">The label names the run under Runs.</span>{' '}
              <span id="launch-budget-hint">A budget stops a run once it has spent that much.</span>
            </p>
          </div>
        </div>
      </div>

      <div className="launch-bar">
        <span id="launch-summary" className="launch-summary">
          {summary}
        </span>
        {budget.ok ? null : (
          <span className="error-text" role="alert">
            {budget.error}
          </span>
        )}
        <button
          type="button"
          className="primary launch-go"
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
