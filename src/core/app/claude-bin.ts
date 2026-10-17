// Which claude binary Overlord runs, and with what environment, when it runs
// claude outside a terminal tab: SDK runs, the jobs poll and background starts.
// Also reads the overlord.agents setting, which picks a binary per agent.

import { z } from 'zod';

import type { AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { AgentCli } from '../agents/types.js';
import { findOnPath } from '../find-on-path.js';
import { mergeEnv } from '../harness/options.js';

import type { AgentSetting, OverlordSettings } from './host-port.js';

/**
 * The binary SDK runs use. The host only searched the editor's PATH, so a bare
 * name is looked up again on the login shell's. A bare default name found
 * nowhere leaves the SDK to its bundled CLI.
 */
export function executableFor(
  claudePath: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  command = 'claude',
): string | null {
  const name = claudePath.trim() === '' ? command : claudePath.trim();
  const found = findOnPath({ name, pathValue: env['PATH'], platform });
  if (found !== null) {
    return found;
  }
  return name === command ? null : name;
}

const agentEntrySchema = z.object({
  path: z.unknown().optional(),
  enabled: z.unknown().optional(),
});

/** The overlord.agents setting as the editor hands it over. Entries that are not objects are left out. */
export function parseAgentSettings(raw: unknown): Record<AgentId, AgentSetting> {
  const entries = z.record(z.string(), z.unknown()).safeParse(raw);
  const out: Record<AgentId, AgentSetting> = {};
  for (const [id, value] of Object.entries(entries.success ? entries.data : {})) {
    const entry = agentEntrySchema.safeParse(value);
    if (entry.success) {
      const { path, enabled } = entry.data;
      // A value of the wrong type counts as left out, like a missing one.
      out[id] = {
        path: typeof path === 'string' ? path.trim() : '',
        enabled: typeof enabled === 'boolean' ? enabled : true,
      };
    }
  }
  return out;
}

/**
 * The Claude binary setting. overlord.claudePath wins when the user set it,
 * so nobody's setup breaks, then the claude-code path in overlord.agents,
 * then claudePath's default.
 */
export function claudePathSetting(
  explicit: string | undefined,
  agents: Readonly<Record<AgentId, AgentSetting>>,
  fallback: string,
): string {
  const fromAgents = agents[CLAUDE_CODE]?.path ?? '';
  return explicit ?? (fromAgents === '' ? fallback : fromAgents);
}

type AgentSettings = Pick<OverlordSettings, 'claudePath' | 'agents'>;

/** The binary the user set for an agent, or "" for its default name. */
export function agentPath(settings: AgentSettings, id: AgentId): string {
  return id === CLAUDE_CODE ? settings.claudePath : (settings.agents[id]?.path ?? '');
}

/** False when overlord.agents turns the agent off. */
export function agentEnabled(settings: AgentSettings, id: AgentId): boolean {
  return settings.agents[id]?.enabled ?? true;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the CLI against the login shell's environment on each call, so a
 * settings change takes effect. A bare claude found nowhere is left to PATH.
 */
export function cliLoader(
  settings: { readonly claudePath: string },
  loginEnv: () => Promise<Env>,
  platform: NodeJS.Platform,
): () => Promise<AgentCli> {
  return async () => {
    const env = await loginEnv();
    return {
      bin: executableFor(settings.claudePath, env, platform) ?? 'claude',
      env: mergeEnv(env, {}),
    };
  };
}
