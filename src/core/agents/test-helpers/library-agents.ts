// A registry where Copilot CLI and Codex CLI are installed and have their
// skill and agent folders, for tests of what happens once other agents are in
// play. The real adapters only get their library facets from the Copilot and
// Codex milestones, so tests add them here.

import { claudeCode } from '../claude/index.js';
import { codex } from '../codex/index.js';
import { codexLibrary } from '../codex/library.js';
import { copilot } from '../copilot/index.js';
import { copilotLibrary } from '../copilot/library.js';
import { AgentRegistry } from '../registry.js';
import type { AgentAdapter, Detected, LibraryFacet } from '../types.js';

/** The adapter with its binary found and the given folders. */
function installedWith(adapter: AgentAdapter, library: LibraryFacet): AgentAdapter {
  return {
    ...adapter,
    detect: async (): Promise<Detected> => {
      await Promise.resolve();
      return { bin: `/usr/local/bin/${adapter.id}`, version: null };
    },
    config: { settingsFormat: 'json', ...adapter.config, library },
  };
}

/** Claude Code, Copilot CLI and Codex CLI, all in play. */
export function threeAgents(): AgentRegistry {
  return new AgentRegistry([
    claudeCode,
    installedWith(copilot, copilotLibrary),
    installedWith(codex, codexLibrary),
  ]);
}

/** Claude Code with Copilot CLI or Codex CLI alone. */
export function withOne(which: 'copilot' | 'codex'): AgentRegistry {
  return new AgentRegistry([
    claudeCode,
    which === 'copilot'
      ? installedWith(copilot, copilotLibrary)
      : installedWith(codex, codexLibrary),
  ]);
}
