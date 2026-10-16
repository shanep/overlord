// cspell:ignore ultracode cach retr notif keybind imum
// Keyword rules that put every knob in one area of the Knobs view, and the one
// table that says where a change to a knob takes effect.

import type { KnobArea } from '../../shared/knob-areas.js';
import type { AppliesAt, KnobKind } from '../../shared/model.js';

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
  // Areas added after the first set. They come last so they only take keys the
  // older rules left in other.
  {
    area: 'policy',
    pattern:
      /policy|managed|required(?:Min|Max)imumVersion|parentSettings|remoteSettings|wslInherits|admin_?env/iu,
  },
  { area: 'updates', pattern: /update|upgrade|install|version|growthbook|release_?channel/iu },
  {
    area: 'git',
    pattern: /attribution|(?:^|[_-])pr(?:[_-]|$)|pr(?:Url|Status)|commit|co_?authored|perforce/iu,
  },
  { area: 'tools', pattern: /web_?(?:fetch|search)/iu },
  { area: 'network', pattern: /watchdog|streaming/iu },
  { area: 'ui', pattern: /demo|hide_?cwd|quiet|prompt_?suggestion|backspace/iu },
  { area: 'bash', pattern: /rm_?prompt/iu },
  {
    area: 'auth',
    pattern: /organization|workspace_?id|federation|client_?key|logout|cost|usage/iu,
  },
  { area: 'sessions', pattern: /session|resume|continue|remote|cloud|ccr|background|bg_|job/iu },
  { area: 'sessions', pattern: /adopt|away|history|fork|exit_?after|goal|worker|restricted/iu },
  {
    area: 'sessions',
    pattern: /print|(?:input|output)[_-]format|replay|partial|ref$|environment|task_?list/iu,
  },
  { area: 'sessions', pattern: /turns|max[_-]?budget/iu },
  { area: 'tools', pattern: /glob|file_?read|attachment|file_?mention|checkpoint|cron|workflow/iu },
  { area: 'tools', pattern: /artifact|chrome|cfc|browser|simulator|ripgrep|tasks?(?:[_-]|$)/iu },
  { area: 'tools', pattern: /tools|structured_?output|syntax|init|script_?caps|add-dir/iu },
  { area: 'telemetry', pattern: /debug|log_?level|logs_?dir|tracing|you_?should_?know/iu },
  { area: 'model', pattern: /max_?output_?tokens|betas?|extra_?body|custom_?headers/iu },
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
  /** Only managed policy can set the key, so it belongs with the other admin keys. */
  readonly managedOnly?: boolean | undefined;
  /** The settings reference topic, or "" when the page has none. */
  readonly topic: string;
  readonly description: string;
}

export function classifyArea(input: AreaInput): KnobArea {
  if (input.managedOnly === true) {
    return 'policy';
  }
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
