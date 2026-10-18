// Typed messages between the extension host and the webviews. Every message
// is plain JSON. The host sends a full `state` for the active view and then
// `patch` messages as data changes. The webview sends `ready` once and then
// `action` messages for user intent.

import type { ActivityState } from './activity.js';
import type { AgentInfo } from './agents.js';
import type { LibraryState } from './catalog.js';
import type { ConnectorsState } from './connectors.js';
import type { KnobsState } from './knobs.js';
import type { ReputationState } from './reputation.js';
import type { TuningState } from './tuning.js';
import type { UsageState } from './usage-state.js';
import { isViewId, type ViewId } from './view-ids.js';
import type {
  AgentDetailState,
  ConfigState,
  ContextState,
  FleetState,
  LauncherState,
  MessagesState,
  PropertiesState,
  SessionsState,
} from './view-states.js';
import type { WebviewAction } from './webview-actions.js';

export type { EditableLayer, KnobsState } from './knobs.js';
export type {
  ClimateAssumptions,
  ClimateEstimate,
  ModelClimate,
  PlanLimit,
  PlanLimits,
  UsageState,
  UsageStats,
} from './usage-state.js';
export { isViewId, VIEW_IDS, type ViewId } from './view-ids.js';
export type {
  AgentDetailState,
  AgentMessage,
  ConfigState,
  ConfigSyncStatus,
  ContextState,
  FleetState,
  HandoffKind,
  LaunchFolder,
  LaunchRun,
  LauncherState,
  MessageRoute,
  MessagesState,
  ProjectSummary,
  PropertiesState,
  RateLimits,
  SessionProject,
  SessionsState,
  SurfaceSession,
} from './view-states.js';
export type { WebviewAction } from './webview-actions.js';
export type { WorktreeOverlap, WorktreeState, WorktreeSummary } from './worktrees.js';

/** The help page is static, so it needs no data from the host. */
type HelpState = Readonly<Record<string, never>>;

interface ViewStateMap {
  readonly fleet: FleetState;
  readonly agent: AgentDetailState;
  readonly context: ContextState;
  readonly knobs: KnobsState;
  readonly launcher: LauncherState;
  readonly sessions: SessionsState;
  readonly config: ConfigState;
  readonly usage: UsageState;
  readonly reputation: ReputationState;
  readonly messages: MessagesState;
  readonly properties: PropertiesState;
  readonly help: HelpState;
  readonly tuning: TuningState;
  readonly connectors: ConnectorsState;
  readonly activity: ActivityState;
  readonly skills: LibraryState;
  readonly agents: LibraryState;
}

/** One view's state, before the host adds what every view gets. */
export type ViewStateMessage = {
  readonly [V in ViewId]: {
    readonly type: 'state';
    readonly view: V;
    readonly state: ViewStateMap[V];
  };
}[ViewId];

export type HostToWebview = ViewStateMessage & {
  /** Every agent Overlord knows, installed or not. */
  readonly agents: readonly AgentInfo[];
};

export type WebviewToHost =
  | { readonly type: 'ready'; readonly view: ViewId }
  | { readonly type: 'action'; readonly action: WebviewAction };

/** Narrow an unknown postMessage payload to a WebviewToHost message. */
export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  if (value.type === 'ready') {
    return 'view' in value && isViewId(value.view);
  }
  if (value.type === 'action') {
    if (!('action' in value) || typeof value.action !== 'object' || value.action === null) {
      return false;
    }
    return 'type' in value.action && typeof value.action.type === 'string';
  }
  return false;
}
