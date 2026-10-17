// Codex CLI as an agent adapter. Overlord reads its rollout files for the
// Fleet and starts or resumes sessions in terminal tabs. Driving and hooking
// Codex come in later milestones of META-HARNESS.md.

import { CODEX } from '../../../shared/agents.js';
import { executableFor } from '../../app/claude-bin.js';
import type { AgentAdapter, DetectInput, Detected } from '../types.js';

import {
  CODEX_CAPABILITIES,
  CODEX_EFFORT_LEVELS,
  CODEX_NAME,
  CODEX_PERMISSION_MODES,
  CODEX_SHORT,
} from './capabilities.js';
import { codexInstructions } from './instructions.js';
import { codexModels } from './models.js';
import { codexObserverFacet } from './observer.js';
import { codexTerminal } from './terminal.js';

/** Finds the binary on the login shell's PATH without running it, so the version stays unknown. */
async function detect(input: DetectInput): Promise<Detected> {
  await Promise.resolve();
  return {
    bin: executableFor(input.path, input.env, input.platform, codexTerminal.command),
    version: null,
  };
}

export const codex: AgentAdapter = {
  id: CODEX,
  name: CODEX_NAME,
  short: CODEX_SHORT,
  icon: 'terminal',
  detect,
  capabilities: CODEX_CAPABILITIES,
  modes: { permission: CODEX_PERMISSION_MODES, effort: CODEX_EFFORT_LEVELS },
  models: codexModels,
  terminal: codexTerminal,
  observer: codexObserverFacet,
  instructions: codexInstructions,
};
