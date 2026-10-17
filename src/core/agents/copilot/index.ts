// GitHub Copilot CLI as an agent adapter. Milestone 1 of META-HARNESS.md:
// Overlord finds the binary and watches the sessions Copilot writes to disk.
// Launching, terminal tabs, approvals and hooks come in later milestones, so
// those capabilities stay off until they work.
// cspell:words xhigh

import type { AgentCapabilities, ModeOption } from '../../../shared/agents.js';
import { COPILOT } from '../../../shared/agents.js';
import { findOnPath } from '../../find-on-path.js';
import type { AgentAdapter, DetectInput, Detected } from '../types.js';

import { copilotInstructions } from './instructions.js';
import { COPILOT_DEFAULT_MODEL, copilotContextWindow } from './models.js';
import { copilotObserverFacet } from './observer.js';

const CAPABILITIES: AgentCapabilities = {
  launch: false,
  terminal: false,
  background: false,
  resume: false,
  fork: false,
  interrupt: false,
  liveModelChange: false,
  livePermissionMode: false,
  approvals: false,
  subagents: true,
  // session.shutdown reports cache reads and writes per model.
  cacheReads: true,
  cacheWrites: true,
  // Copilot reports what it charged in nano AI units, which convert to dollars.
  costUsd: true,
  contextInspector: false,
  hooks: false,
  messaging: false,
  handoffs: [],
};

/** The agent modes from --mode, plus --allow-all, which turns every permission prompt off. */
const PERMISSION_MODES: readonly ModeOption[] = [
  { id: 'interactive', label: 'Interactive' },
  { id: 'plan', label: 'Plan' },
  { id: 'autopilot', label: 'Autopilot' },
  { id: 'allow-all', label: 'Allow all', risky: true },
];

/** The values --reasoning-effort takes in Copilot CLI 1.0.89. */
const EFFORT_LEVELS: readonly ModeOption[] = [
  { id: 'none', label: 'None' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

const BINARY = 'copilot';

/** Finds the binary on the login shell's PATH without running it, so the version stays unknown. */
async function detect(input: DetectInput): Promise<Detected> {
  await Promise.resolve();
  const name = input.path.trim() === '' ? BINARY : input.path.trim();
  return {
    bin: findOnPath({ name, pathValue: input.env['PATH'], platform: input.platform }),
    version: null,
  };
}

export const copilot: AgentAdapter = {
  id: COPILOT,
  name: 'Copilot CLI',
  short: 'Copilot',
  icon: 'copilot',
  detect,
  capabilities: CAPABILITIES,
  modes: { permission: PERMISSION_MODES, effort: EFFORT_LEVELS },
  models: {
    contextWindow: copilotContextWindow,
    // Copilot reports each session's cost itself, so there is no price table.
    price: () => null,
    defaultModel: COPILOT_DEFAULT_MODEL,
  },
  observer: copilotObserverFacet,
  instructions: copilotInstructions,
};
