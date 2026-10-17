// The areas the Knobs view groups keys into, in display order, with the title
// and one line summary each area shows. Shared so the catalog generator and
// the webview agree on the same list.

export type KnobArea =
  | 'model'
  | 'thinking'
  | 'context'
  | 'memory'
  | 'caching'
  | 'permissions'
  | 'bash'
  | 'tools'
  | 'mcp'
  | 'plugins'
  | 'subagents'
  | 'sessions'
  | 'git'
  | 'ui'
  | 'auth'
  | 'network'
  | 'telemetry'
  | 'updates'
  | 'policy'
  | 'other';

export interface KnobAreaInfo {
  readonly title: string;
  readonly summary: string;
}

const KNOB_AREA_INFO: Readonly<Record<KnobArea, KnobAreaInfo>> = {
  model: { title: 'Model and output', summary: 'Which model runs, fallbacks, output style.' },
  thinking: { title: 'Thinking and effort', summary: 'Extended thinking, effort level, advisor.' },
  context: {
    title: 'Context and compaction',
    summary: 'System prompt, context window, compaction.',
  },
  memory: { title: 'Memory and CLAUDE.md', summary: 'Auto memory and which CLAUDE.md files load.' },
  caching: { title: 'Prompt caching', summary: 'Cache TTL and turning caching off.' },
  permissions: { title: 'Permissions', summary: 'Allow, ask and deny rules and the default mode.' },
  bash: { title: 'Bash and sandbox', summary: 'Shell, output limits and the sandbox.' },
  tools: {
    title: 'Built-in tools',
    summary: 'WebFetch, WebSearch, Glob, tasks, browser, artifacts.',
  },
  mcp: { title: 'MCP servers', summary: 'MCP servers, timeouts, tool search, connectors.' },
  plugins: { title: 'Plugins, skills and hooks', summary: 'Plugins, marketplaces, skills, hooks.' },
  subagents: { title: 'Subagents and worktrees', summary: 'Subagents, teammates and worktrees.' },
  sessions: {
    title: 'Sessions and print mode',
    summary: 'Resume, background jobs, cloud and remote sessions, scripting.',
  },
  git: {
    title: 'Git and attribution',
    summary: 'Commit and pull request attribution, PR links, Perforce mode.',
  },
  ui: { title: 'Interface', summary: 'Theme, terminal, status line, IDE, notifications.' },
  auth: { title: 'Accounts and providers', summary: 'API keys, login, Bedrock, Vertex, Foundry.' },
  network: { title: 'Network', summary: 'Proxies, certificates, timeouts, retries.' },
  telemetry: {
    title: 'Telemetry and logging',
    summary: 'OpenTelemetry, error reports, debug logs.',
  },
  updates: {
    title: 'Updates and install',
    summary: 'Auto updates, release channel, install checks.',
  },
  policy: {
    title: 'Organization policy',
    summary: 'Keys only managed settings can set, for admins.',
  },
  other: { title: 'Other', summary: 'Keys that fit nowhere else.' },
};

/**
 * The summaries above name Claude Code's own keys (CLAUDE.md, Bedrock, print
 * mode). Another agent's Knobs view uses these words instead, and names its
 * own instruction file in the memory area.
 */
const OTHER_AGENT_AREA_INFO: Partial<Record<KnobArea, KnobAreaInfo>> = {
  thinking: { title: 'Thinking and effort', summary: 'Reasoning effort and how much of it shows.' },
  tools: {
    title: 'Built-in tools',
    summary: 'Web search, file edits and the other tools it runs.',
  },
  mcp: { title: 'MCP servers', summary: 'MCP servers, timeouts and tool approval.' },
  subagents: { title: 'Subagents and worktrees', summary: 'Subagents and worktrees.' },
  sessions: { title: 'Sessions and scripting', summary: 'Resume, history and scripted runs.' },
  git: { title: 'Git and attribution', summary: 'Commit and pull request attribution.' },
  auth: { title: 'Accounts and providers', summary: 'API keys, login and model providers.' },
};

/**
 * An area's title and summary for one agent. Null instructions mean Claude
 * Code, whose words the table above uses. Another agent passes its
 * instruction file, such as AGENTS.md.
 */
export function knobAreaInfo(area: KnobArea, instructionsFile: string | null): KnobAreaInfo {
  if (instructionsFile === null) {
    return KNOB_AREA_INFO[area];
  }
  if (area === 'memory') {
    const file = instructionsFile.split('/').at(-1) ?? instructionsFile;
    return { title: `Memory and ${file}`, summary: `Memory and the ${file} files it reads.` };
  }
  return OTHER_AGENT_AREA_INFO[area] ?? KNOB_AREA_INFO[area];
}

export const KNOB_AREAS: readonly KnobArea[] = [
  'model',
  'thinking',
  'context',
  'memory',
  'caching',
  'permissions',
  'bash',
  'tools',
  'mcp',
  'plugins',
  'subagents',
  'sessions',
  'git',
  'ui',
  'auth',
  'network',
  'telemetry',
  'updates',
  'policy',
  'other',
];

const AREA_SET: ReadonlySet<string> = new Set(KNOB_AREAS);

export function isKnobArea(value: string): value is KnobArea {
  return AREA_SET.has(value);
}
