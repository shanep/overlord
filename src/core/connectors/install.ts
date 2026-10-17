// Turns an install plan from the registry and what the user typed into the
// server config an agent's MCP store adds, in the JSON shape
// `claude mcp add-json` takes. An argument, variable or header whose optional
// input is empty is left out whole, so a flag never goes without its value.

import type { InstallInput } from '../../shared/connectors.js';
import type { McpServerConfig } from '../agents/types.js';

import type { ArgumentGroup, Entry, InstallPlan, Template } from './registry.js';

/** Server names: letters, digits, dashes and underscores, which every agent takes. */
export const NAME_PATTERN = /^[\w-]{1,64}$/u;

export type BuildResult =
  | { readonly ok: true; readonly config: McpServerConfig }
  | { readonly ok: false; readonly error: string };

type Values = Readonly<Record<string, string>>;

/** The template's text, or null when one of its inputs is empty. */
function fill(template: Template, values: Values): string | null {
  let text = '';
  for (const part of template) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    const value = values[part.input]?.trim() ?? '';
    if (value === '') {
      return null;
    }
    text += value;
  }
  return text;
}

function group(words: ArgumentGroup, values: Values): string[] {
  const filled = words.map((word) => fill(word, values));
  return filled.includes(null) ? [] : filled.filter((word): word is string => word !== null);
}

function entries(list: readonly Entry[], values: Values): Record<string, string> | undefined {
  const pairs = list.flatMap((entry) => {
    const value = fill(entry.value, values);
    return value === null ? [] : [[entry.name, value] as const];
  });
  return pairs.length === 0 ? undefined : Object.fromEntries(pairs);
}

export function buildConfig(
  plan: InstallPlan,
  inputs: readonly InstallInput[],
  values: Values,
): BuildResult {
  const missing = inputs.filter(
    (entry) => entry.required && (values[entry.id]?.trim() ?? '') === '',
  );
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Fill in ${missing.map((entry) => entry.label).join(', ')} first.`,
    };
  }
  if (plan.via === 'remote') {
    const url = fill(plan.url, values);
    if (url === null) {
      return { ok: false, error: 'The URL needs every value it names.' };
    }
    const headers = entries(plan.headers, values);
    return {
      ok: true,
      config: { type: plan.kind, url, ...(headers === undefined ? {} : { headers }) },
    };
  }
  const env = entries(plan.env, values);
  return {
    ok: true,
    config: {
      type: 'stdio',
      command: plan.command,
      args: plan.args.flatMap((words) => group(words, values)),
      ...(env === undefined ? {} : { env }),
    },
  };
}
