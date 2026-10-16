// cspell:ignore ultracode cach retr notif keybind
// Keyword rules that put every knob in one area of the Knobs view, and the one
// table that says where a change to a knob takes effect.

import type { AppliesAt, KnobKind } from '../../shared/model.js';

export type KnobArea =
  | 'model'
  | 'thinking'
  | 'context'
  | 'caching'
  | 'subagents'
  | 'bash'
  | 'mcp'
  | 'telemetry'
  | 'memory'
  | 'permissions'
  | 'auth'
  | 'ui'
  | 'network'
  | 'plugins'
  | 'other';

export const KNOB_AREAS: readonly KnobArea[] = [
  'model',
  'thinking',
  'context',
  'caching',
  'subagents',
  'bash',
  'mcp',
  'telemetry',
  'memory',
  'permissions',
  'auth',
  'ui',
  'network',
  'plugins',
  'other',
];

interface AreaRule {
  readonly area: KnobArea;
  readonly pattern: RegExp;
}

/**
 * Tried in order against the key, then the docs topic, then the first sentence
 * of the description. The first hit wins.
 */
const AREA_RULES: readonly AreaRule[] = [
  { area: 'thinking', pattern: /thinking|effort|ultracode|advisor/iu },
  { area: 'caching', pattern: /cach(?:e|ing)/iu },
  { area: 'context', pattern: /compact|context|system[_-]?prompt/iu },
  { area: 'model', pattern: /model|fallback|fast_?mode|output_?style|language/iu },
  { area: 'subagents', pattern: /subagent|(?<![a-z])agents?(?![a-z])|teammate|worktree/iu },
  { area: 'bash', pattern: /bash|shell|sandbox/iu },
  { area: 'mcp', pattern: /mcp|tool_?search|connector/iu },
  { area: 'telemetry', pattern: /telemetry|otel|metric|error_?report|feedback|survey/iu },
  { area: 'memory', pattern: /memory|claude_?md/iu },
  {
    area: 'permissions',
    pattern: /permission|allowed_?tools|disallowed|dangerous|bypass|auto_?mode/iu,
  },
  {
    area: 'auth',
    pattern: /auth|api_?key|oauth|login|bedrock|vertex|foundry|aws|gcp|provider|credential/iu,
  },
  { area: 'network', pattern: /proxy|tls|cert|network|timeout|retr(?:y|ies)|base_?url|domain/iu },
  { area: 'ui', pattern: /theme|tui|terminal|screen|spinner|vim|editor|status_?line|notif/iu },
  { area: 'ui', pattern: /color|verbose|picker|tips|keybind|(?:^|[_-])ide(?:[_-]|$)/iu },
  { area: 'ui', pattern: /Ide(?:[A-Z]|$)/u },
  { area: 'plugins', pattern: /plugin|marketplace|skill|hook|channel/iu },
];

/** The settings reference groups keys by topic. Used when no keyword matches the key. */
const TOPIC_AREAS: ReadonlyMap<string, KnobArea> = new Map<string, KnobArea>([
  ['Agents, sessions, and worktrees', 'subagents'],
  ['Authentication and providers', 'auth'],
  ['Hooks and automation', 'plugins'],
  ['Interface and terminal', 'ui'],
  ['MCP', 'mcp'],
  ['Memory and context', 'memory'],
  ['Model and responses', 'model'],
  ['Permission settings', 'permissions'],
  ['Plugins and skills', 'plugins'],
  ['Privacy and telemetry', 'telemetry'],
  ['Remote, desktop, and notifications', 'ui'],
  ['Sandbox settings', 'bash'],
]);

function matchRules(text: string): KnobArea | null {
  return AREA_RULES.find((rule) => rule.pattern.test(text))?.area ?? null;
}

export interface AreaInput {
  readonly key: string;
  /** The settings reference topic, or "" when the page has none. */
  readonly topic: string;
  readonly description: string;
}

export function classifyArea(input: AreaInput): KnobArea {
  const fromKey = matchRules(input.key);
  if (fromKey !== null) {
    return fromKey;
  }
  const end = input.description.indexOf('. ');
  const firstSentence = end === -1 ? input.description : input.description.slice(0, end);
  return TOPIC_AREAS.get(input.topic) ?? matchRules(firstSentence) ?? 'other';
}

/**
 * Settings the Agent SDK can change in a running session. Everything else, and
 * every env var and flag, applies at the next launch.
 */
const LIVE_SETTINGS: ReadonlyMap<string, AppliesAt> = new Map<string, AppliesAt>([
  ['model', 'live'],
  ['permissions.defaultMode', 'live'],
]);

export function appliesAtFor(kind: KnobKind, key: string): AppliesAt {
  if (kind !== 'setting') {
    return 'next-launch';
  }
  return LIVE_SETTINGS.get(key) ?? 'next-launch';
}
