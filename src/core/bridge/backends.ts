// The backends Overlord knows, and which one a profile or env picks. The
// Launcher and terminal tabs both resolve a backend here, so a profile's
// backend field and the old ANTHROPIC_BASE_URL placeholder mean the same
// thing on both. Nothing here imports vscode or starts a process.

import type { AgentId } from '../../shared/agents.js';

import type { Backend } from './backend.js';
import { BOISESTATE } from './boisestate.js';

/** Every backend Overlord knows. */
export const BACKENDS: readonly Backend[] = [BOISESTATE];

/** What picks a backend: a profile's backend field, or an env that claims one. */
export interface BackendChoice {
  readonly backend?: string | undefined;
  readonly env: Readonly<Record<string, string>>;
}

/** The backend id a profile or env picks, or null for the agent's own account. */
export function backendIdOf(choice: BackendChoice): string | null {
  if (choice.backend !== undefined && choice.backend !== '') {
    return choice.backend;
  }
  return BACKENDS.find((backend) => backend.claims(choice.env))?.id ?? null;
}

/** The backend with this id, or null when Overlord knows none. */
export function findBackend(id: string): Backend | null {
  return BACKENDS.find((item) => item.id === id) ?? null;
}

/** The backend for an id when it serves the agent. Throws with a message to show when it does not. */
export function backendFor(id: string, agent: AgentId): Backend {
  const backend = findBackend(id);
  if (backend === null) {
    throw new Error(`Unknown backend "${id}"`);
  }
  if (!backend.appliesTo(agent)) {
    throw new Error(`The ${backend.name} backend does not run ${agent} sessions`);
  }
  return backend;
}

/** The backend a profile or env picks for the agent, or null for its own account. */
export function chosenBackend(choice: BackendChoice, agent: AgentId): Backend | null {
  const id = backendIdOf(choice);
  return id === null ? null : backendFor(id, agent);
}

/** The backends a pick can offer for the agent. */
export function backendsFor(agent: AgentId): readonly Backend[] {
  return BACKENDS.filter((backend) => backend.appliesTo(agent));
}
