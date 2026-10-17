// Claude Code as an agent adapter. It points at the Claude code where it
// sits today. The facets past models and terminal come in Phase 1 of
// META-HARNESS.md.

import type { ModeOption } from '../../../shared/agents.js';
import { CLAUDE_CODE } from '../../../shared/agents.js';
import { claudeContextWindow } from '../../../shared/model.js';
import { executableFor } from '../../app/claude-bin.js';
import { DEFAULT_MODEL } from '../../app/prices.js';
import { DEFAULT_PRICES, findPrice } from '../../transcripts/pricing.js';
import type { AgentAdapter, AgentWords, DetectInput, Detected } from '../types.js';

import { CLAUDE_CAPABILITIES } from './capabilities.js';
import { claudeConfig } from './config.js';
import { claudeHooks } from './hooks.js';
import { claudeInject } from './inject.js';
import { claudeInstructions } from './instructions.js';
import { claudeObserverFacet } from './observer.js';
import { claudeRuntime } from './runtime.js';
import { claudeTelemetry } from './telemetry.js';
import { CLAUDE_SHORT, claudeTerminal } from './terminal.js';
import { claudeTuning } from './tuning.js';

/** The same modes, in the same order, as PermissionMode in shared/model.ts. */
const PERMISSION_MODES: readonly ModeOption[] = [
  { id: 'default', label: 'Default' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan' },
  { id: 'auto', label: 'Auto' },
  { id: 'dontAsk', label: "Don't ask" },
  { id: 'bypassPermissions', label: 'Bypass permissions', risky: true },
  { id: 'manual', label: 'Manual' },
];

const EFFORT_LEVELS: readonly ModeOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

const WORDS: AgentWords = {
  instructionsFile: 'CLAUDE.md',
  compactCommand: '/compact',
  clearCommand: '/clear',
  rewind: '/rewind (or press Esc twice)',
};

/** Finds the binary the way SDK runs do, without running it, so the version stays unknown. */
async function detect(input: DetectInput): Promise<Detected> {
  await Promise.resolve();
  return { bin: executableFor(input.path, input.env, input.platform), version: null };
}

export const claudeCode: AgentAdapter = {
  id: CLAUDE_CODE,
  name: 'Claude Code',
  short: CLAUDE_SHORT,
  icon: 'sparkle',
  detect,
  capabilities: CLAUDE_CAPABILITIES,
  modes: { permission: PERMISSION_MODES, effort: EFFORT_LEVELS },
  models: {
    contextWindow: claudeContextWindow,
    price: (model) => findPrice(model, DEFAULT_PRICES),
    defaultModel: DEFAULT_MODEL,
  },
  words: WORDS,
  runtime: claudeRuntime(),
  terminal: claudeTerminal,
  observer: claudeObserverFacet,
  hooks: claudeHooks,
  telemetry: claudeTelemetry,
  inject: claudeInject,
  config: claudeConfig,
  instructions: claudeInstructions,
  tuning: claudeTuning,
};
