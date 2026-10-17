// What the UI may offer for Codex sessions, and the modes Codex takes. Kept
// apart from index.ts so the observer can read it without an import cycle.
// cspell:words rollouts

import type { AgentCapabilities, ModeOption } from '../../../shared/agents.js';

export const CODEX_NAME = 'Codex CLI';
export const CODEX_SHORT = 'Codex';

/**
 * Milestones 1 to 4 of META-HARNESS.md: Overlord reads Codex sessions,
 * starts them in tabs, drives them from the Launcher over app-server, and
 * reaches them through hooks and launch overrides.
 */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  launch: true,
  terminal: true,
  background: false,
  resume: true,
  // codex fork <id> continues a copy of a session under a new id.
  fork: true,
  // turn/interrupt stops a Launcher run's turn. A tab still needs Esc.
  interrupt: true,
  // turn/start takes a model for the turn and the ones after it.
  liveModelChange: true,
  // turn/start takes an approval and sandbox policy too, from the next turn on, like the model.
  livePermissionMode: true,
  approvals: true,
  subagents: false,
  // Rollouts report cached input, and cache writes too, though a ChatGPT plan reports 0.
  cacheReads: true,
  cacheWrites: true,
  // A ChatGPT plan bills by plan limits, not tokens, so there is no honest dollar figure.
  costUsd: false,
  contextInspector: false,
  // Launcher runs and tabs Overlord opens get the notes as developer_instructions. Other
  // sessions get them, and edit conflict blocks, from the hooks once the user trusts them.
  hooks: true,
  messaging: false,
  handoffs: ['resume-local'],
};

const APPROVALS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'untrusted', label: 'ask before untrusted commands' },
  { id: 'on-request', label: 'ask when it needs to' },
  { id: 'never', label: 'never ask' },
];

const SANDBOXES: readonly {
  readonly id: string;
  readonly label: string;
  readonly risky: boolean;
}[] = [
  { id: 'read-only', label: 'Read only', risky: false },
  { id: 'workspace-write', label: 'Edit the workspace', risky: false },
  { id: 'danger-full-access', label: 'Full access', risky: true },
];

interface Permission {
  readonly approvalPolicy: string;
  readonly sandbox: string;
}

/** The id for one approval_policy and sandbox_mode pair, as the summary reports it. */
export function permissionModeId(approval: string, sandbox: string): string {
  return `${approval}/${sandbox}`;
}

/**
 * Codex sets permissions with two keys, approval_policy and sandbox_mode, so
 * each mode is one pair of them. Full access lets commands touch anything on
 * the machine, so every mode with it is risky.
 */
export const CODEX_PERMISSION_MODES: readonly ModeOption[] = SANDBOXES.flatMap((sandbox) =>
  APPROVALS.map((approval): ModeOption => ({
    id: permissionModeId(approval.id, sandbox.id),
    label: `${sandbox.label}, ${approval.label}`,
    ...(sandbox.risky ? { risky: true } : {}),
  })),
);

/** One of Codex's mode ids, "approval/sandbox", split into its two settings. */
export function splitMode(mode: string): Permission {
  const [approvalPolicy, sandbox] = mode.split('/');
  if (
    approvalPolicy === undefined ||
    sandbox === undefined ||
    !CODEX_PERMISSION_MODES.some((option) => option.id === mode)
  ) {
    throw new Error(`Unknown permission mode "${mode}"`);
  }
  return { approvalPolicy, sandbox };
}

/** model_reasoning_effort values Codex 0.163.0 lists for its models. */
export const CODEX_EFFORT_LEVELS: readonly ModeOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];
