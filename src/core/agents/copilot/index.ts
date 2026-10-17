// GitHub Copilot CLI as an agent adapter. Milestones 1 to 4 of
// META-HARNESS.md: Overlord finds the binary, watches the sessions Copilot
// writes to disk, starts and resumes them in terminal tabs, runs them from
// the Launcher over ACP, and hears from them through its hooks.
// cspell:words xhigh

import type { ModeOption } from '../../../shared/agents.js';
import { COPILOT } from '../../../shared/agents.js';
import { findOnPath } from '../../find-on-path.js';
import type { AgentAdapter, AgentWords, DetectInput, Detected } from '../types.js';

import { COPILOT_CAPABILITIES, COPILOT_SHORT } from './capabilities.js';
import { copilotHooks } from './hooks.js';
import { copilotInject } from './inject.js';
import { copilotInstructions } from './instructions.js';
import { copilotLibrary } from './library.js';
import { copilotMcp } from './mcp.js';
import { COPILOT_DEFAULT_MODEL, copilotContextWindow } from './models.js';
import { copilotObserverFacet } from './observer.js';
import { copilotRuntime } from './runtime.js';
import { COPILOT_BINARY, copilotTerminal } from './terminal.js';

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

/** From `copilot help commands` in 1.0.89. /rewind also reverts the turn's file changes. */
const WORDS: AgentWords = {
  instructionsFile: '.github/copilot-instructions.md',
  compactCommand: '/compact',
  clearCommand: '/clear',
  rewind: '/rewind',
};

/** Finds the binary on the login shell's PATH without running it, so the version stays unknown. */
async function detect(input: DetectInput): Promise<Detected> {
  await Promise.resolve();
  const name = input.path.trim() === '' ? COPILOT_BINARY : input.path.trim();
  return {
    bin: findOnPath({ name, pathValue: input.env['PATH'], platform: input.platform }),
    version: null,
  };
}

export const copilot: AgentAdapter = {
  id: COPILOT,
  name: 'Copilot CLI',
  short: COPILOT_SHORT,
  icon: 'copilot',
  detect,
  capabilities: COPILOT_CAPABILITIES,
  modes: { permission: PERMISSION_MODES, effort: EFFORT_LEVELS },
  models: {
    contextWindow: copilotContextWindow,
    // Copilot reports each session's cost itself, so there is no price table.
    price: () => null,
    defaultModel: COPILOT_DEFAULT_MODEL,
  },
  words: WORDS,
  runtime: copilotRuntime,
  terminal: copilotTerminal,
  observer: copilotObserverFacet,
  hooks: copilotHooks,
  inject: copilotInject,
  instructions: copilotInstructions,
  config: { settingsFormat: 'json', mcp: copilotMcp, library: copilotLibrary },
};
