// Codex CLI as an agent adapter. Overlord reads its rollout files for the
// Fleet, starts or resumes sessions in terminal tabs, drives Launcher runs
// over `codex app-server`, hooks it through $CODEX_HOME/hooks.json, gives
// sessions it starts its notes as developer_instructions, and reads its OTel
// logs.

import { CODEX } from '../../../shared/agents.js';
import { executableFor } from '../../app/claude-bin.js';
import type { AgentAdapter, AgentWords, DetectInput, Detected } from '../types.js';

import {
  CODEX_CAPABILITIES,
  CODEX_EFFORT_LEVELS,
  CODEX_NAME,
  CODEX_PERMISSION_MODES,
  CODEX_SHORT,
} from './capabilities.js';
import { codexKnobs } from './config.js';
import { codexHooks } from './hooks.js';
import { codexInject } from './inject.js';
import { codexInstructions } from './instructions.js';
import { codexLibrary } from './library.js';
import { codexMcp } from './mcp.js';
import { codexModels } from './models.js';
import { codexObserverFacet } from './observer.js';
import { codexRuntime } from './runtime.js';
import { codexSync } from './sync.js';
import { codexTelemetry } from './telemetry.js';
import { codexTerminal } from './terminal.js';

/** Finds the binary on the login shell's PATH without running it, so the version stays unknown. */
async function detect(input: DetectInput): Promise<Detected> {
  await Promise.resolve();
  return {
    bin: executableFor(input.path, input.env, input.platform, codexTerminal.command),
    version: null,
  };
}

/**
 * What Codex 0.163.0 calls things: AGENTS.md, /compact, and /new to start
 * over (its /clear clears the terminal too). It has no rewind command, only
 * Esc twice to edit an earlier prompt, which advice cannot run as a command.
 */
const WORDS: AgentWords = {
  instructionsFile: 'AGENTS.md',
  compactCommand: '/compact',
  clearCommand: '/new',
  rewind: null,
};

export const codex: AgentAdapter = {
  id: CODEX,
  name: CODEX_NAME,
  short: CODEX_SHORT,
  icon: 'terminal',
  detect,
  capabilities: CODEX_CAPABILITIES,
  modes: { permission: CODEX_PERMISSION_MODES, effort: CODEX_EFFORT_LEVELS },
  models: codexModels,
  words: WORDS,
  runtime: codexRuntime(),
  terminal: codexTerminal,
  observer: codexObserverFacet,
  hooks: codexHooks,
  telemetry: codexTelemetry,
  inject: codexInject,
  instructions: codexInstructions,
  config: {
    settingsFormat: 'toml',
    mcp: codexMcp,
    knobs: codexKnobs,
    library: codexLibrary,
    sync: codexSync,
  },
};
