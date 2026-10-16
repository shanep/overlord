// cspell:ignore xyzzy ultracode notif autoupdater
import { describe, expect, it } from 'vitest';

import { KNOB_AREAS, type KnobArea } from '../../shared/knob-areas.js';

import { appliesAtFor, classifyArea } from './areas.js';

function areaOf(key: string, topic = '', description = ''): KnobArea {
  return classifyArea({ key, topic, description });
}

describe('KNOB_AREAS', () => {
  it('lists every area once, in display order, ending with other', () => {
    expect(KNOB_AREAS).toStrictEqual([
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
    ]);
  });
});

describe('classifyArea', () => {
  it.each([
    ['MAX_THINKING_TOKENS', 'thinking'],
    ['effortLevel', 'thinking'],
    ['ultracode', 'thinking'],
    ['advisorModel', 'thinking'],
    ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'caching'],
    ['promptCacheTtl', 'caching'],
    ['DISABLE_PROMPT_CACHING', 'caching'],
    ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'context'],
    ['--append-system-prompt', 'context'],
    ['CLAUDE_CODE_SYSTEM_PROMPT', 'context'],
    ['contextWindow', 'context'],
    ['model', 'model'],
    ['fallbackModel', 'model'],
    ['CLAUDE_CODE_DISABLE_FAST_MODE', 'model'],
    ['fastMode', 'model'],
    ['outputStyle', 'model'],
    ['OUTPUT_STYLE', 'model'],
    ['language', 'model'],
    ['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 'subagents'],
    ['--agent', 'subagents'],
    ['--agents', 'subagents'],
    ['CLAUDE_AGENT_SDK_X', 'subagents'],
    ['teammateMode', 'subagents'],
    ['worktree.baseRef', 'subagents'],
    ['BASH_MAX_OUTPUT_LENGTH', 'bash'],
    ['CLAUDE_CODE_SHELL', 'bash'],
    ['sandbox.enabled', 'bash'],
    ['MCP_TIMEOUT', 'mcp'],
    ['ENABLE_TOOL_SEARCH', 'mcp'],
    ['toolSearch', 'mcp'],
    ['disableClaudeAiConnectors', 'mcp'],
    ['CLAUDE_CODE_ENABLE_TELEMETRY', 'telemetry'],
    ['OTEL_METRICS_EXPORTER', 'telemetry'],
    ['DISABLE_ERROR_REPORTING', 'telemetry'],
    ['errorReporting', 'telemetry'],
    ['feedbackSurveyRate', 'telemetry'],
    ['autoMemoryEnabled', 'memory'],
    ['claudeMdExcludes', 'memory'],
    ['CLAUDE_MD_PATH', 'memory'],
    ['permissions.allow', 'permissions'],
    ['--allowedTools', 'permissions'],
    ['ALLOWED_TOOLS', 'permissions'],
    ['--disallowedTools', 'permissions'],
    ['--dangerously-skip-permissions', 'permissions'],
    ['bypassMode', 'permissions'],
    ['disableAutoMode', 'permissions'],
    ['AUTO_MODE', 'permissions'],
    ['ANTHROPIC_AUTH_TOKEN', 'auth'],
    ['apiKeyHelper', 'auth'],
    ['ANTHROPIC_API_KEY', 'auth'],
    ['oauthScopes', 'auth'],
    ['forceLoginMethod', 'auth'],
    ['CLAUDE_CODE_USE_BEDROCK', 'auth'],
    ['CLAUDE_CODE_USE_VERTEX', 'auth'],
    ['CLAUDE_CODE_USE_FOUNDRY', 'auth'],
    ['AWS_REGION', 'auth'],
    ['GCP_PROJECT', 'auth'],
    ['allowedProviders', 'auth'],
    ['awsCredentialExport', 'auth'],
    ['HTTPS_PROXY', 'network'],
    ['NODE_TLS', 'network'],
    ['CLAUDE_CODE_CLIENT_CERT', 'network'],
    ['sandbox.network.x', 'bash'],
    ['networkAccess', 'network'],
    ['API_TIMEOUT_MS', 'network'],
    ['MAX_RETRIES', 'network'],
    ['retryCount', 'network'],
    ['ANTHROPIC_BASE_URL', 'network'],
    ['allowedDomains', 'network'],
    ['enabledPlugins', 'plugins'],
    ['extraKnownMarketplaces', 'plugins'],
    ['SKILL_DIR', 'plugins'],
    ['disableAllHooks', 'plugins'],
    ['allowedChannelPlugins', 'plugins'],
    ['channelsEnabled', 'plugins'],
    ['theme', 'ui'],
    ['tui', 'ui'],
    ['CLAUDE_CODE_TERMINAL', 'ui'],
    ['axScreenReader', 'ui'],
    ['spinnerTipsEnabled', 'ui'],
    ['vimMode', 'ui'],
    ['editorMode', 'ui'],
    ['statusLine', 'ui'],
    ['STATUS_LINE', 'ui'],
    ['preferredNotifChannel', 'ui'],
    ['FORCE_COLOR', 'ui'],
    ['--verbose', 'ui'],
    ['modelPicker', 'model'],
    ['viewPicker', 'ui'],
    ['companyAnnouncements.tips', 'ui'],
    ['keybindings', 'ui'],
    ['CLAUDE_CODE_AUTO_CONNECT_IDE', 'ui'],
    ['IDE_PORT', 'ui'],
    ['--ide', 'ui'],
    ['autoConnectIde', 'ui'],
    ['autoInstallIdeExtension', 'ui'],
    ['CLAUDE_CODE_DISABLE_WEB_FETCH', 'tools'],
    ['CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION', 'tools'],
    ['CLAUDE_CODE_GLOB_HIDDEN', 'tools'],
    ['enableArtifact', 'tools'],
    ['--chrome', 'tools'],
    ['--continue', 'sessions'],
    ['--output-format', 'sessions'],
    ['--max-budget-usd', 'sessions'],
    ['CLAUDE_CODE_RESUME_PROMPT', 'sessions'],
    ['remoteControlAtStartup', 'sessions'],
    ['attribution.commit', 'git'],
    ['prUrlTemplate', 'git'],
    ['CLAUDE_CODE_PERFORCE_MODE', 'git'],
    ['DISABLE_AUTOUPDATER', 'updates'],
    ['minimumVersion', 'updates'],
    ['--version', 'updates'],
    ['requiredMinimumVersion', 'policy'],
    ['policyHelper.path', 'policy'],
    ['DEBUG', 'telemetry'],
    ['--debug-file', 'telemetry'],
    ['CLAUDE_ENABLE_STREAM_WATCHDOG', 'network'],
    ['IS_DEMO', 'ui'],
    ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'model'],
    ['DISABLE_COST_WARNINGS', 'auth'],
    ['CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT', 'bash'],
  ])('puts %s in %s', (key, area) => {
    expect(areaOf(key)).toBe(area);
  });

  it('puts every managed only key in policy, whatever its name', () => {
    expect(classifyArea({ key: 'model', topic: '', description: '', managedOnly: true })).toBe(
      'policy',
    );
    expect(classifyArea({ key: 'model', topic: '', description: '', managedOnly: false })).toBe(
      'model',
    );
  });

  it('does not read "ide" inside a longer word', () => {
    expect(areaOf('HIDE_BANNER')).toBe('other');
    expect(areaOf('sidebar')).toBe('other');
    expect(areaOf('slideshow')).toBe('other');
    expect(areaOf('agentic')).toBe('other');
    expect(areaOf('reagent')).toBe('other');
  });

  it('prefers the key over the topic and the topic over the description', () => {
    expect(areaOf('promptCacheTtl', 'Model and responses')).toBe('caching');
    expect(areaOf('xyzzy', 'Model and responses', 'Runs bash')).toBe('model');
    expect(areaOf('xyzzy', '', 'Runs bash commands')).toBe('bash');
  });

  it.each([
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
  ])('maps the %s topic to %s', (topic, area) => {
    expect(areaOf('xyzzy', topic)).toBe(area);
  });

  it('ignores unknown topics and reads only the first sentence of the description', () => {
    expect(areaOf('xyzzy', 'Git and attribution')).toBe('other');
    expect(areaOf('xyzzy', 'constructor')).toBe('other');
    expect(areaOf('xyzzy', '', 'Sets the theme. Also mentions bash.')).toBe('ui');
    expect(areaOf('xyzzy', '', 'Plain words. Then bash. And mcp.')).toBe('other');
    expect(areaOf('xyzzy', '', 'Uses bash.sh files')).toBe('bash');
  });
});

describe('appliesAtFor', () => {
  it('marks the settings the SDK can change live', () => {
    expect(appliesAtFor('setting', 'model')).toBe('live');
    expect(appliesAtFor('setting', 'permissions.defaultMode')).toBe('live');
  });

  it('puts every other knob at the next launch', () => {
    expect(appliesAtFor('setting', 'effortLevel')).toBe('next-launch');
    expect(appliesAtFor('setting', 'toString')).toBe('next-launch');
    expect(appliesAtFor('env', 'model')).toBe('next-launch');
    expect(appliesAtFor('flag', 'model')).toBe('next-launch');
    expect(appliesAtFor('flag', '--model')).toBe('next-launch');
  });
});
