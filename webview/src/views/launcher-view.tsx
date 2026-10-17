// Launcher: start many agents and prompts at once, watch the runs and their
// worktrees, answer permission requests, and manage auto-approve rules.

import type { ReactElement } from 'react';

import type { LauncherState } from '../../../src/shared/protocol.js';

import { LaunchFormView } from './launcher-form.js';
import { PermissionInbox } from './launcher-permissions.js';
import { RulesEditor } from './launcher-rules.js';
import { RunsTable } from './launcher-runs.js';
import { isActiveRun } from './launcher-values.js';
import { WorktreesTable } from './launcher-worktrees.js';

export function LauncherView(props: { readonly state: LauncherState }): ReactElement {
  const { state } = props;
  // A waiting request holds its run up, so it goes above the runs until it is answered.
  const waiting = state.pendingPermissions.length > 0;
  const inbox = <PermissionInbox requests={state.pendingPermissions} />;
  const active = state.runs.filter((run) => isActiveRun(run)).length;
  return (
    <div className="launcher">
      <header className="view-header">
        <h1>Launcher</h1>
        <dl className="stats">
          <div className="stat">
            <dt>Active runs</dt>
            <dd>{String(active)}</dd>
          </div>
          <div className="stat">
            <dt>Waiting on you</dt>
            <dd>{String(state.pendingPermissions.length)}</dd>
          </div>
          <div className="stat">
            <dt>Worktrees</dt>
            <dd>{String(state.worktrees.length)}</dd>
          </div>
        </dl>
      </header>
      <details className="about">
        <summary>How this works</summary>
        <p>
          Hand one prompt to Claude and let it work on its own, with no chat. Pick several profiles
          to run the same prompt with different models or settings and compare the results. To talk
          with Claude back and forth instead, use the sparkle button.
        </p>
      </details>
      <LaunchFormView
        profiles={state.profiles}
        drafts={state.drafts}
        defaultFolder={state.defaultFolder}
      />
      {waiting ? inbox : null}
      <RunsTable
        runs={state.runs}
        profiles={state.profiles}
        maxConcurrency={state.maxConcurrency}
      />
      <WorktreesTable worktrees={state.worktrees} />
      {waiting ? null : inbox}
      <RulesEditor rules={state.rules} />
    </div>
  );
}
