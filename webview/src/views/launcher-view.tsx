// Launcher: start many agents and prompts at once, watch the runs and their
// worktrees, answer permission requests, and manage auto-approve rules.

import type { ReactElement } from 'react';

import type { LauncherState } from '../../../src/shared/protocol.js';

import { LaunchFormView } from './launcher-form.js';
import { PermissionInbox } from './launcher-permissions.js';
import { RulesEditor } from './launcher-rules.js';
import { RunsTable } from './launcher-runs.js';
import { WorktreesTable } from './launcher-worktrees.js';

export function LauncherView(props: { readonly state: LauncherState }): ReactElement {
  const { state } = props;
  // A waiting request holds its run up, so it goes above the runs until it is answered.
  const waiting = state.pendingPermissions.length > 0;
  const inbox = <PermissionInbox requests={state.pendingPermissions} />;
  return (
    <div>
      <div className="view-header">
        <h1>Launcher</h1>
      </div>
      <p className="lead">
        Hand one prompt to Claude and let it work on its own, with no chat. Pick several profiles to
        run the same prompt with different models or settings and compare the results. To talk with
        Claude back and forth instead, use the sparkle button.
      </p>
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
