// Claude Code as an agent adapter. It points at the Claude code where it
// sits today. The facets past models and terminal come in Phase 1 of
// META-HARNESS.md.

import type { AgentCapabilities, ModeOption } from '../../../shared/agents.js';
import { CLAUDE_CODE } from '../../../shared/agents.js';
import { contextWindow } from '../../../shared/model.js';
import type { HandoffKind } from '../../../shared/protocol.js';
import { executableFor } from '../../app/claude-bin.js';
import { DEFAULT_MODEL } from '../../app/prices.js';
import { DEFAULT_PRICES, findPrice } from '../../transcripts/pricing.js';
import type { AgentAdapter, DetectInput, Detected } from '../types.js';

import { claudeConfig } from './config.js';
import { claudeHooks } from './hooks.js';
import { claudeInject } from './inject.js';
import { claudeObserverFacet } from './observer.js';
import { claudeRuntime } from './runtime.js';
import { claudeTelemetry } from './telemetry.js';
import { CLAUDE_SHORT, claudeTerminal } from './terminal.js';

const HANDOFFS: readonly HandoffKind[] = [
  'resume-local',
  'open-desktop',
  'teleport-local',
  'remote-control',
];

const CAPABILITIES: AgentCapabilities = {
  launch: true,
  terminal: true,
  background: true,
  resume: true,
  fork: true,
  interrupt: true,
  liveModelChange: true,
  livePermissionMode: true,
  approvals: true,
  subagents: true,
  cacheReads: true,
  cacheWrites: true,
  costUsd: true,
  contextInspector: true,
  hooks: true,
  messaging: true,
  handoffs: HANDOFFS,
};

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
  capabilities: CAPABILITIES,
  modes: { permission: PERMISSION_MODES, effort: EFFORT_LEVELS },
  models: {
    contextWindow,
    price: (model) => findPrice(model, DEFAULT_PRICES),
    defaultModel: DEFAULT_MODEL,
  },
  runtime: claudeRuntime(),
  terminal: claudeTerminal,
  observer: claudeObserverFacet,
  hooks: claudeHooks,
  telemetry: claudeTelemetry,
  inject: claudeInject,
  config: claudeConfig,
};
