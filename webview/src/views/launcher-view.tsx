// Launcher: start many agents and prompts at once, watch the runs, answer
// permission requests, and manage auto-approve rules.

import type { ReactElement } from 'react';

import type { LauncherState } from '../../../src/shared/protocol.js';

import { LaunchFormView } from './launcher-form.js';
import { PermissionInbox } from './launcher-permissions.js';
import { RulesEditor } from './launcher-rules.js';
import { RunsTable } from './launcher-runs.js';

export function LauncherView(props: { readonly state: LauncherState }): ReactElement {
  const { state } = props;
  return (
    <div>
      <div className="view-header">
        <h1>Launcher</h1>
      </div>
      <LaunchFormView profiles={state.profiles} drafts={state.drafts} />
      <RunsTable
        runs={state.runs}
        profiles={state.profiles}
        maxConcurrency={state.maxConcurrency}
      />
      <PermissionInbox requests={state.pendingPermissions} />
      <RulesEditor rules={state.rules} />
    </div>
  );
}
