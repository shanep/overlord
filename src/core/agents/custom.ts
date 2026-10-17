// Custom agents from the overlord.customAgents setting. Any command that
// speaks the Agent Client Protocol over stdio becomes an agent the Launcher
// can run, drive and approve through the ACP runtime. Overlord does not read
// its files, install hooks in it or edit its config, so those facets stay
// off.
//
//   "overlord.customAgents": [
//     { "id": "gemini", "name": "Gemini CLI", "command": "gemini",
//       "args": ["--experimental-acp"] }
//   ]
//
// A bad entry is left out with a warning, and nothing here ever quotes an
// env value, since those often hold keys.

import path from 'node:path';

import { z } from 'zod';

import type { AgentCapabilities, AgentId, ModeOption } from '../../shared/agents.js';
import { findOnPath, isExecutableFile } from '../find-on-path.js';

import { acpRuntime } from './acp/runtime.js';
import type { AgentRegistry } from './registry.js';
import type { AgentAdapter, DetectInput, Detected } from './types.js';

/** One entry of overlord.customAgents, checked. */
export interface CustomAgentSpec {
  readonly id: AgentId;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** A codicon id. */
  readonly icon: string;
  /** Permission modes, each id passed to the agent as its ACP mode id. */
  readonly modes: readonly ModeOption[];
}

/** The setting as Overlord reads it: the entries it took and why it left out the rest. */
export interface CustomAgentsSetting {
  readonly agents: readonly CustomAgentSpec[];
  /** One line per entry left out. */
  readonly problems: readonly string[];
}

export const NO_CUSTOM_AGENTS: CustomAgentsSetting = { agents: [], problems: [] };

const SETTING = 'overlord.customAgents';
const ID_PATTERN = /^[A-Za-z0-9][\w.-]*$/u;

const modeSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  risky: z.boolean().optional(),
});

const entrySchema = z.object({
  id: z.string().regex(ID_PATTERN),
  name: z.string().trim().min(1),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  icon: z
    .string()
    .regex(/^[a-z0-9-]+$/u)
    .default('terminal'),
  modes: z.array(modeSchema).default([]),
});

/** What is wrong with an entry, by the first field that failed. Never quotes a value. */
const FIELD_PROBLEMS: Readonly<Record<string, string>> = {
  id: 'needs an id made of letters, digits, dots, dashes and underscores',
  name: 'needs a name',
  command: 'needs a command',
  args: 'has args that are not a list of strings',
  env: 'has an env whose values are not all strings',
  icon: 'has an icon that is not a codicon id',
  modes: 'has modes that are not a list of { id, label?, risky? }',
};

type Checked = { readonly spec: CustomAgentSpec } | { readonly problem: string };

function checkEntry(
  value: unknown,
  reserved: ReadonlySet<AgentId>,
  taken: ReadonlySet<AgentId>,
): Checked {
  const parsed = entrySchema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { problem: FIELD_PROBLEMS[String(field)] ?? 'is not an object' };
  }
  const { modes, ...entry } = parsed.data;
  if (reserved.has(entry.id)) {
    return { problem: 'has the id of a built-in agent' };
  }
  if (taken.has(entry.id)) {
    return { problem: 'has the same id as an earlier entry' };
  }
  const options = modes.map(({ id, label, risky }) => ({
    id,
    label: label ?? id,
    ...(risky === true ? { risky } : {}),
  }));
  return { spec: { ...entry, modes: options } };
}

function entryName(value: unknown, index: number): string {
  const which = `entry ${String(index + 1)}`;
  const id = z.object({ id: z.string().regex(ID_PATTERN) }).safeParse(value);
  return id.success ? `${which} ("${id.data.id}")` : which;
}

/**
 * Reads overlord.customAgents. Entries that are not right, or that take a
 * built-in agent's id or an earlier entry's, are left out with a problem line.
 */
export function parseCustomAgents(
  raw: unknown,
  reserved: ReadonlySet<AgentId>,
): CustomAgentsSetting {
  if (raw === undefined || raw === null) {
    return NO_CUSTOM_AGENTS;
  }
  if (!Array.isArray(raw)) {
    return { agents: [], problems: [`${SETTING} should be a list of agents, so it was ignored.`] };
  }
  const entries: readonly unknown[] = raw;
  const agents: CustomAgentSpec[] = [];
  const problems: string[] = [];
  const taken = new Set<AgentId>();
  for (const [index, value] of entries.entries()) {
    const checked = checkEntry(value, reserved, taken);
    if ('problem' in checked) {
      const name = entryName(value, index);
      problems.push(`${SETTING} ${name} ${checked.problem}, so Overlord skipped it.`);
    } else {
      taken.add(checked.spec.id);
      agents.push(checked.spec);
    }
  }
  return { agents, problems };
}

const NO_CAPABILITIES: AgentCapabilities = {
  launch: false,
  terminal: false,
  background: false,
  resume: false,
  fork: false,
  interrupt: false,
  liveModelChange: false,
  livePermissionMode: false,
  approvals: false,
  subagents: false,
  cacheReads: false,
  cacheWrites: false,
  costUsd: false,
  contextInspector: false,
  hooks: false,
  messaging: false,
  handoffs: [],
};

/**
 * Finds the command on the login shell's PATH without running it, so the
 * version stays unknown. A relative path such as ./agent counts as missing,
 * since a run starts in its own folder and would not find it there.
 */
async function detectCommand(command: string, input: DetectInput): Promise<Detected> {
  await Promise.resolve();
  if (path.isAbsolute(command)) {
    return { bin: isExecutableFile(command) ? command : null, version: null };
  }
  if (command.includes('/') || command.includes('\\')) {
    return { bin: null, version: null };
  }
  const bin = findOnPath({ name: command, pathValue: input.env['PATH'], platform: input.platform });
  return { bin, version: null };
}

/** The adapter for one entry: launch, approvals and interrupt through the ACP runtime. */
export function customAgent(spec: CustomAgentSpec): AgentAdapter {
  return {
    id: spec.id,
    name: spec.name,
    short: spec.name,
    icon: spec.icon,
    detect: async (input) => detectCommand(spec.command, input),
    capabilities: {
      ...NO_CAPABILITIES,
      launch: true,
      approvals: true,
      interrupt: true,
      livePermissionMode: spec.modes.length > 0,
    },
    modes: { permission: spec.modes, effort: [] },
    models: {
      contextWindow: () => null,
      // The agent picks its own model, so there is no price table.
      price: () => null,
      defaultModel: '',
    },
    runtime: acpRuntime({ command: spec.command, args: spec.args, env: spec.env }),
  };
}

/** Where the custom agents come from, and where a warning about one goes. */
interface CustomAgentsHost {
  readonly settings: { readonly customAgents: CustomAgentsSetting };
  readonly showWarning: (message: string) => void;
}

/**
 * Puts the host's custom agents in the registry now, and again each time the
 * returned function runs, as after a settings change. Each entry left out is
 * warned about once.
 */
export function trackCustomAgents(registry: AgentRegistry, host: CustomAgentsHost): () => void {
  const warned = new Set<string>();
  const apply = (): void => {
    const setting = host.settings.customAgents;
    registry.setCustom(setting.agents.map((spec) => customAgent(spec)));
    for (const problem of setting.problems.filter((line) => !warned.has(line))) {
      warned.add(problem);
      host.showWarning(problem);
    }
  };
  apply();
  return apply;
}
