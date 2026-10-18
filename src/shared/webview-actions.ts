// What a webview asks the host to do.

import type { AgentId } from './agents.js';
import type { CatalogKind } from './catalog.js';
import type { EditableLayer } from './knobs.js';
import type { KnobKind, LaunchProfile, LaunchSpec, PermissionDecision } from './model.js';
import type { AutoApproveRule } from './rules.js';
import type { ViewId } from './view-ids.js';
import type { HandoffKind } from './view-states.js';

export type WebviewAction =
  | { readonly type: 'openSession'; readonly sessionId: string }
  | { readonly type: 'openAgent'; readonly sessionId: string; readonly agentId: string }
  | { readonly type: 'openContext'; readonly sessionId: string; readonly agentId: string | null }
  | { readonly type: 'openProperties'; readonly sessionId: string }
  | { readonly type: 'interrupt'; readonly sessionId: string }
  | { readonly type: 'stop'; readonly sessionId: string }
  | { readonly type: 'removeSession'; readonly sessionId: string }
  | { readonly type: 'setModel'; readonly sessionId: string; readonly model: string }
  | { readonly type: 'setPermissionMode'; readonly sessionId: string; readonly mode: string }
  | {
      readonly type: 'resolvePermission';
      readonly requestId: string;
      readonly decision: PermissionDecision;
    }
  | { readonly type: 'launch'; readonly specs: readonly LaunchSpec[] }
  | { readonly type: 'stopRun'; readonly runId: string }
  | { readonly type: 'stopAll' }
  | { readonly type: 'browseLaunchFolder' }
  | { readonly type: 'alwaysAllowPermission'; readonly requestId: string }
  | { readonly type: 'saveRule'; readonly rule: AutoApproveRule }
  | { readonly type: 'deleteRule'; readonly ruleId: string }
  | { readonly type: 'saveProfile'; readonly profile: LaunchProfile }
  | { readonly type: 'deleteProfile'; readonly profileId: string }
  | {
      readonly type: 'setKnob';
      readonly key: string;
      readonly value: unknown;
      readonly layer: EditableLayer;
      /** The agent whose settings change. Unset means Claude Code. */
      readonly agent?: AgentId;
    }
  | {
      readonly type: 'openKnobDocs';
      readonly key: string;
      readonly kind: KnobKind;
      /** The agent whose catalog has the key. Unset means Claude Code. */
      readonly agent?: AgentId;
    }
  /** Shows another agent's knobs in the Knobs view. */
  | { readonly type: 'pickKnobsAgent'; readonly agent: AgentId }
  | { readonly type: 'handoff'; readonly sessionId: string; readonly kind: HandoffKind }
  | { readonly type: 'importClaudeAi' }
  | { readonly type: 'syncPush' }
  | { readonly type: 'syncPull' }
  | { readonly type: 'turnOnSync' }
  | { readonly type: 'syncNow' }
  | { readonly type: 'adoptConfig'; readonly itemId: string }
  | { readonly type: 'openFile'; readonly path: string }
  | { readonly type: 'openView'; readonly view: ViewId }
  | { readonly type: 'newAgent' }
  | { readonly type: 'newSkill' }
  | { readonly type: 'browseCatalog'; readonly kind: CatalogKind; readonly source: string }
  | { readonly type: 'searchCatalog'; readonly kind: CatalogKind; readonly query: string }
  | { readonly type: 'openCatalogLink'; readonly kind: CatalogKind; readonly url: string }
  | { readonly type: 'installCatalog'; readonly kind: CatalogKind; readonly entryId: string }
  | { readonly type: 'rescanReputation' }
  | { readonly type: 'uploadReputation' }
  | { readonly type: 'removeReputation' }
  | { readonly type: 'refreshLeaderboard' }
  | { readonly type: 'openLeaderboard' }
  | { readonly type: 'rescanTuning' }
  | { readonly type: 'createSuggestion'; readonly suggestionId: string }
  | { readonly type: 'installPick'; readonly pickId: string }
  | { readonly type: 'openPickLink'; readonly pickId: string }
  | { readonly type: 'trackTip'; readonly tipId: string; readonly on: boolean }
  | { readonly type: 'draftPlan'; readonly goal: string; readonly cwd: string }
  | { readonly type: 'approvePlan'; readonly planId: string }
  | { readonly type: 'discardPlan'; readonly planId: string }
  | { readonly type: 'stopPlan'; readonly planId: string }
  | { readonly type: 'retryPlanTask'; readonly planId: string; readonly taskId: string }
  | { readonly type: 'recheckConnectors' }
  | { readonly type: 'fixConnector'; readonly connectorId: string }
  | { readonly type: 'searchRegistry'; readonly query: string }
  | { readonly type: 'moreRegistry' }
  | { readonly type: 'openRegistryLink'; readonly url: string }
  | {
      readonly type: 'installConnector';
      /** The registry name of the server. */
      readonly server: string;
      /** Which of the server's install options. */
      readonly option: number;
      /** The name to give it in the agent. */
      readonly name: string;
      /** What the user typed, keyed by input id. */
      readonly values: Readonly<Record<string, string>>;
      /** The agent to add it to. Unset means Claude Code. */
      readonly agent?: AgentId;
    }
  | { readonly type: 'setInboundPolicy'; readonly value: string | null }
  | { readonly type: 'newSession'; readonly agent?: AgentId }
  | { readonly type: 'newBridgeChat' }
  | { readonly type: 'landWorktree'; readonly id: string }
  | { readonly type: 'discardWorktree'; readonly id: string }
  | { readonly type: 'openWorktree'; readonly id: string }
  | { readonly type: 'moveSession'; readonly sessionId: string }
  | { readonly type: 'continueInFolder'; readonly sessionId: string }
  | { readonly type: 'newProject'; readonly sessionId: string }
  | { readonly type: 'renameProject'; readonly projectId: string }
  | { readonly type: 'deleteProject'; readonly projectId: string }
  | { readonly type: 'openProjectFolder'; readonly projectId: string }
  | { readonly type: 'setProjectFolder'; readonly projectId: string }
  | { readonly type: 'combineSessions'; readonly sessionId: string }
  | { readonly type: 'renameSession'; readonly sessionId: string }
  /** Set or clear a session's token budget. */
  | { readonly type: 'setBudget'; readonly sessionId: string }
  | { readonly type: 'openProject' }
  | { readonly type: 'newProjectSession'; readonly projectId: string };
