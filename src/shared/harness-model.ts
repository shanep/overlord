// The harness: permission requests and answers, launch profiles and launch specs.

import type { AgentId } from './agents.js';

export interface PermissionRequest {
  readonly id: string;
  readonly sessionId: string;
  /** The agent CLI that asked, not the subagent (that is agentId). */
  readonly agent: AgentId;
  readonly agentId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly requestedAt: number;
  /** Runtime is any programmatic driver other than the Claude SDK. */
  readonly source: 'sdk' | 'hook' | 'runtime';
  /** The answers this request takes. Unset means allow and deny only. */
  readonly choices?: readonly PermissionChoice[];
}

/**
 * One answer to a permission request: allow this call, allow it for the rest
 * of the session, deny it, or deny it and stop the turn. Each runtime maps
 * these to its agent's own options.
 */
export type PermissionChoice = 'allow' | 'allow_session' | 'deny' | 'cancel';

export type PermissionDecision =
  | {
      readonly behavior: 'allow';
      readonly ruleId: string | null;
      /** Session lets the agent skip asking again. Unset is once. */
      readonly scope?: 'once' | 'session';
    }
  | {
      readonly behavior: 'deny';
      readonly message: string;
      readonly ruleId: string | null;
      /** Also stops the current turn. */
      readonly interrupt?: boolean;
    };

/** What the inbox may offer for a request. */
export function permissionChoices(request: PermissionRequest): readonly PermissionChoice[] {
  return request.choices ?? ['allow', 'deny'];
}

/** The decision an inbox button sends. */
export function choiceDecision(choice: PermissionChoice, denyMessage: string): PermissionDecision {
  switch (choice) {
    case 'allow': {
      return { behavior: 'allow', ruleId: null };
    }
    case 'allow_session': {
      return { behavior: 'allow', ruleId: null, scope: 'session' };
    }
    case 'deny': {
      return { behavior: 'deny', message: denyMessage, ruleId: null };
    }
    case 'cancel': {
      return { behavior: 'deny', message: denyMessage, ruleId: null, interrupt: true };
    }
  }
}

export interface LaunchProfile {
  readonly id: string;
  readonly name: string;
  /** Saved profiles without one are Claude Code profiles. */
  readonly agent: AgentId;
  /** The model endpoint behind the agent, for example "boisestate". Unset is the agent's own. */
  readonly backend?: string;
  readonly model: string | null;
  readonly effort: string | null;
  /** An id from the agent's permission modes. */
  readonly permissionMode: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly extraArgs: readonly string[];
}

export interface LaunchSpec {
  /** The agent for a run with no profile, when the Launcher offered a pick. Unset is Claude Code. */
  readonly agent?: AgentId;
  readonly prompt: string;
  readonly cwd: string;
  readonly profileId: string | null;
  readonly worktree: boolean;
  readonly maxBudgetUsd: number | null;
  readonly label: string;
}
