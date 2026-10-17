// Reads servers from the public MCP registry (registry.modelcontextprotocol.io)
// and works out how to install each one: a remote URL Claude Code connects to,
// or an npm, PyPI or Docker package it runs. Anything else the registry lists,
// such as an .mcpb bundle or a package that serves HTTP on localhost, is left
// out because Claude Code cannot start it from one command.

import { z } from 'zod';

import type {
  InstallInput,
  InstallKind,
  InstallOption,
  RegistryServer,
} from '../../shared/connectors.js';

/** A piece of a value: literal text, or what the user typed for an input. */
type Part = string | { readonly input: string };
export type Template = readonly Part[];
/** Arguments that go in or out together, such as a flag and its value. */
export type ArgumentGroup = readonly Template[];

export interface Entry {
  readonly name: string;
  readonly value: Template;
}

type PackageKind = Exclude<InstallKind, 'http' | 'sse'>;

interface RemotePlan {
  readonly via: 'remote';
  readonly kind: 'http' | 'sse';
  readonly url: Template;
  readonly headers: readonly Entry[];
}

interface PackagePlan {
  readonly via: 'package';
  readonly kind: PackageKind;
  readonly command: string;
  readonly args: readonly ArgumentGroup[];
  readonly env: readonly Entry[];
}

export type InstallPlan = RemotePlan | PackagePlan;

/** A server as the registry lists it, plus the plan behind each install option. */
export interface RegistryEntry {
  readonly server: RegistryServer;
  readonly plans: readonly InstallPlan[];
}

export interface RegistryPage {
  readonly entries: readonly RegistryEntry[];
  /** Where the next page starts, or null on the last page. */
  readonly next: string | null;
}

const input = z.looseObject({
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  value: z.string().optional(),
});

const withVariables = input.extend({
  variables: z.record(z.string(), input).optional(),
});

const keyValue = withVariables.extend({ name: z.string().min(1) });

const argument = withVariables.extend({
  type: z.string(),
  name: z.string().optional(),
  valueHint: z.string().optional(),
});

const transport = z.looseObject({ type: z.string() });

const packageSchema = z.looseObject({
  registryType: z.string(),
  identifier: z.string().min(1),
  version: z.string().optional(),
  runtimeHint: z.string().optional(),
  transport,
  runtimeArguments: z.array(argument).optional(),
  packageArguments: z.array(argument).optional(),
  environmentVariables: z.array(keyValue).optional(),
});

const remote = z.looseObject({
  type: z.string(),
  url: z.string().min(1),
  headers: z.array(keyValue).optional(),
  variables: z.record(z.string(), input).optional(),
});

const server = z.looseObject({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  repository: z.looseObject({ url: z.string().optional() }).optional(),
  packages: z.array(z.unknown()).optional(),
  remotes: z.array(z.unknown()).optional(),
});

const OFFICIAL = 'io.modelcontextprotocol.registry/official';

const listing = z.looseObject({
  servers: z.array(
    z.looseObject({
      server,
      _meta: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  metadata: z.looseObject({ nextCursor: z.string().optional() }).optional(),
});

const official = z.looseObject({ status: z.string().optional() });

type Input = z.infer<typeof input>;
type Variables = Readonly<Record<string, Input>>;
type Argument = z.infer<typeof argument>;
type KeyValue = z.infer<typeof keyValue>;

const VARIABLE = /\{([A-Za-z_][\w.-]*)\}/gu;

/** An input from what the registry says about it, with a fallback for the fields it leaves out. */
function inputOf(id: string, label: string, item: Input = {}, fallback: Input = {}): InstallInput {
  const merged: Input = { ...fallback, ...item };
  return {
    id,
    label,
    description: merged.description ?? '',
    required: merged.isRequired ?? false,
    secret: merged.isSecret ?? false,
    initial: item.default ?? '',
    placeholder: item.placeholder ?? '',
  };
}

/** A named argument with no value: a bare flag, its default when required, or nothing. */
function named(item: Argument): ArgumentGroup | null {
  if (item.name === undefined || item.name === '') {
    return null;
  }
  if (item.default === undefined) {
    return [[item.name]];
  }
  return item.isRequired === true ? [[item.name], [item.default]] : null;
}

/** The inputs an option asks for, in order, once each. */
class Inputs {
  readonly list: InstallInput[] = [];

  add(entry: InstallInput): string {
    if (!this.list.some((known) => known.id === entry.id)) {
      this.list.push(entry);
    }
    return entry.id;
  }

  /** A value with {name} placeholders, each one becoming an input. */
  template(value: string, variables: Variables, parent: Input): Template {
    const parts: Part[] = [];
    let last = 0;
    for (const match of value.matchAll(VARIABLE)) {
      const name = match[1] ?? '';
      const id = this.add(inputOf(`var:${name}`, name, variables[name], parent));
      parts.push(value.slice(last, match.index), { input: id });
      last = match.index + match[0].length;
    }
    parts.push(value.slice(last));
    return parts.filter((part) => part !== '');
  }

  /** An env variable or header: its fixed value, or an input for the user to fill. */
  entry(prefix: string, item: KeyValue): Entry {
    if (item.value !== undefined) {
      return { name: item.name, value: this.template(item.value, item.variables ?? {}, item) };
    }
    const id = this.add(inputOf(`${prefix}:${item.name}`, item.name, item));
    return { name: item.name, value: [{ input: id }] };
  }

  /**
   * One argument. A named flag with only a default is left off so the server
   * uses its default, and a named one with no value at all is a bare flag.
   */
  argument(item: Argument, index: number): ArgumentGroup | null {
    if (item.value !== undefined) {
      const flag: ArgumentGroup =
        item.type === 'named' && item.name !== undefined ? [[item.name]] : [];
      return [...flag, this.template(item.value, item.variables ?? {}, item)];
    }
    if (item.type === 'named') {
      return named(item);
    }
    const hint = item.valueHint ?? String(index);
    const label = item.valueHint ?? `Argument ${String(index + 1)}`;
    return [[{ input: this.add(inputOf(`arg:${hint}`, label, item)) }]];
  }

  arguments(items: readonly Argument[] | undefined): ArgumentGroup[] {
    return (items ?? []).flatMap((item, index) => {
      const group = this.argument(item, index);
      return group === null ? [] : [group];
    });
  }
}

function literal(group: ArgumentGroup): string | null {
  const [only] = group;
  return group.length === 1 && only?.length === 1 && typeof only[0] === 'string' ? only[0] : null;
}

function hasLiteral(groups: readonly ArgumentGroup[], values: readonly string[]): boolean {
  return groups.some((group) => {
    const first = group[0];
    return first?.length === 1 && typeof first[0] === 'string' && values.includes(first[0]);
  });
}

interface Launch {
  readonly lead: readonly ArgumentGroup[];
  readonly before: readonly ArgumentGroup[];
  readonly target: string;
  readonly env: readonly Entry[];
}

interface LaunchInput {
  readonly identifier: string;
  readonly version: string;
  readonly before: readonly ArgumentGroup[];
  readonly env: readonly Entry[];
}

function npmLaunch(item: LaunchInput): Launch {
  return {
    lead: hasLiteral(item.before, ['-y', '--yes']) ? [] : [[['-y']]],
    before: item.before,
    target: item.version === '' ? item.identifier : `${item.identifier}@${item.version}`,
    env: item.env,
  };
}

function pypiLaunch(item: LaunchInput): Launch {
  const pinned = item.version !== '' && !hasLiteral(item.before, ['--from']);
  return {
    lead: [],
    before: item.before,
    target: pinned ? `${item.identifier}==${item.version}` : item.identifier,
    env: item.env,
  };
}

function dockerLaunch(item: LaunchInput): Launch {
  // Some images list `run -i --rm` as runtime arguments and some list none.
  const [first, ...rest] = item.before;
  const before = first !== undefined && literal(first) === 'run' ? rest : item.before;
  const flags = ['-i', '--rm'].filter((flag) => !hasLiteral(before, [flag]));
  return {
    lead: [
      [['run']],
      ...flags.map((flag): ArgumentGroup => [[flag]]),
      // The container sees only the variables -e hands it, so they go on the command line.
      ...item.env.map((entry): ArgumentGroup => [['-e'], [`${entry.name}=`, ...entry.value]]),
    ],
    before,
    target: item.identifier,
    env: [],
  };
}

/** The command each package type runs with. A package that asks for another runtime is skipped. */
const RUNTIMES: Readonly<
  Record<
    string,
    {
      readonly kind: PackageKind;
      readonly command: string;
      readonly launch: (item: LaunchInput) => Launch;
    }
  >
> = {
  npm: { kind: 'npm', command: 'npx', launch: npmLaunch },
  pypi: { kind: 'pypi', command: 'uvx', launch: pypiLaunch },
  oci: { kind: 'docker', command: 'docker', launch: dockerLaunch },
};

function packagePlan(value: unknown): { plan: InstallPlan; inputs: InstallInput[] } | null {
  const parsed = packageSchema.safeParse(value);
  if (parsed.data?.transport.type !== 'stdio') {
    return null;
  }
  const item = parsed.data;
  const runtime = RUNTIMES[item.registryType];
  if (runtime === undefined) {
    return null;
  }
  if (item.runtimeHint !== undefined && item.runtimeHint !== runtime.command) {
    return null;
  }
  const inputs = new Inputs();
  const before = inputs.arguments(item.runtimeArguments);
  const after = inputs.arguments(item.packageArguments);
  const env = (item.environmentVariables ?? []).map((entry) => inputs.entry('env', entry));
  const launch = runtime.launch({
    identifier: item.identifier,
    version: item.version ?? '',
    before,
    env,
  });
  return {
    plan: {
      via: 'package',
      kind: runtime.kind,
      command: runtime.command,
      args: [...launch.lead, ...launch.before, [[launch.target]], ...after],
      env: launch.env,
    },
    inputs: inputs.list,
  };
}

function remotePlan(value: unknown): { plan: InstallPlan; inputs: InstallInput[] } | null {
  const parsed = remote.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const kind = parsed.data.type === 'streamable-http' ? 'http' : parsed.data.type;
  if (kind !== 'http' && kind !== 'sse') {
    return null;
  }
  const inputs = new Inputs();
  const url = inputs.template(parsed.data.url, parsed.data.variables ?? {}, { isRequired: true });
  const headers = (parsed.data.headers ?? []).map((entry) => inputs.entry('header', entry));
  return { plan: { via: 'remote', kind, url, headers }, inputs: inputs.list };
}

/** A template as the view shows it, with each input as {label}. */
function shown(template: Template, inputs: readonly InstallInput[]): string {
  return template
    .map((part) =>
      typeof part === 'string'
        ? part
        : `{${inputs.find((entry) => entry.id === part.input)?.label ?? part.input}}`,
    )
    .join('');
}

function summaryOf(plan: InstallPlan, inputs: readonly InstallInput[]): string {
  if (plan.via === 'remote') {
    return shown(plan.url, inputs);
  }
  const words = plan.args.flatMap((group) => group.map((template) => shown(template, inputs)));
  return [plan.command, ...words.filter((word) => word !== '')].join(' ');
}

const AFFIXES = [/^mcp-server-/u, /^server-/u, /^mcp-/u, /-mcp-server$/u, /-server$/u, /-mcp$/u];
const GENERIC = new Set(['', 'mcp', 'server', 'mcp-server']);
/** Domain labels that say nothing about the server, skipped when the namespace names it. */
const DOMAIN_LABELS = new Set([
  'io',
  'com',
  'ai',
  'ac',
  'sh',
  'dev',
  'net',
  'org',
  'app',
  'co',
  'github',
]);

function slug(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((word) => word !== '')
    .join('-');
}

/** A short Claude Code name from the registry name, such as sentry for getsentry/sentry-mcp. */
export function suggestName(registryName: string): string {
  const [namespace = '', last = namespace] = registryName.split('/');
  let name = slug(last);
  for (const affix of AFFIXES) {
    const trimmed = name.replace(affix, '');
    if (!GENERIC.has(trimmed)) {
      name = trimmed;
    }
  }
  if (!GENERIC.has(name)) {
    return name;
  }
  // A server called just mcp takes its name from the namespace, so ai.2kw/mcp-server is 2kw.
  const owner = namespace.split('.').filter((label) => !DOMAIN_LABELS.has(label.toLowerCase()));
  return slug(owner.at(-1) ?? '') || 'server';
}

function entryFrom(raw: z.infer<typeof server>): RegistryEntry {
  const built = [
    ...(raw.remotes ?? []).map((item) => remotePlan(item)),
    ...(raw.packages ?? []).map((item) => packagePlan(item)),
  ].filter((item) => item !== null);
  const options: InstallOption[] = built.map((item) => ({
    kind: item.plan.kind,
    summary: summaryOf(item.plan, item.inputs),
    inputs: item.inputs,
  }));
  return {
    server: {
      name: raw.name,
      title: raw.title ?? raw.name,
      description: raw.description ?? '',
      version: raw.version ?? '',
      repository: raw.repository?.url ?? null,
      suggestedName: suggestName(raw.name),
      options,
    },
    plans: built.map((item) => item.plan),
  };
}

/** The servers in one registry reply, leaving out deprecated and deleted ones. */
export function parseRegistry(value: unknown): RegistryPage {
  const reply = listing.safeParse(value);
  if (!reply.success) {
    throw new Error('The MCP registry sent a reply Overlord could not read.');
  }
  const parsed = reply.data;
  const seen = new Set<string>();
  const entries = parsed.servers.flatMap((item) => {
    const status = official.safeParse(item._meta?.[OFFICIAL]).data?.status ?? 'active';
    if (status !== 'active' || seen.has(item.server.name)) {
      return [];
    }
    seen.add(item.server.name);
    return [entryFrom(item.server)];
  });
  return { entries, next: parsed.metadata?.nextCursor ?? null };
}
