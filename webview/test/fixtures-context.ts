// Context and knobs fixtures.

import type { ContextSnapshot, KnobDefinition } from '../../src/shared/model.js';
import type { ContextState, KnobsState } from '../../src/shared/protocol.js';

import { NOW } from './fixtures.js';

const MINUTE = 60_000;

export const snapshot: ContextSnapshot = {
  sessionId: 's1',
  agentId: 's1',
  at: NOW - MINUTE,
  systemPrompt: ['You are Claude Code.', 'Use tools carefully.'],
  model: 'claude-opus-4-7',
  loaded: [
    {
      path: '/Users/dev/.claude/CLAUDE.md',
      tier: 'User',
      reason: 'session_start',
      triggerPath: null,
      parentPath: null,
      globs: [],
      bytes: 2048,
      differsFromDisk: false,
      loadedAt: NOW - 10 * MINUTE,
    },
    {
      path: '/Users/dev/repos/app/src/CLAUDE.md',
      tier: 'Project',
      reason: 'nested_traversal',
      triggerPath: '/Users/dev/repos/app/src/parser.ts',
      parentPath: '/Users/dev/repos/app/CLAUDE.md',
      globs: ['src/**'],
      bytes: 512,
      differsFromDisk: true,
      loadedAt: null,
    },
  ],
  skipped: [
    {
      path: '/Users/dev/repos/app/vendor/CLAUDE.md',
      tier: 'Project',
      exists: true,
      code: 'excluded',
      detail: 'Excluded by claudeMdExcludes pattern in user settings.',
    },
  ],
  skills: [
    {
      name: 'writing-voice',
      source: 'user',
      path: '/Users/dev/.claude/skills/writing-voice',
      listed: true,
      invoked: true,
      descriptionChars: 420,
    },
    {
      name: 'pdf',
      source: 'plugin',
      path: null,
      listed: true,
      invoked: false,
      descriptionChars: 300,
    },
  ],
  agentTypes: ['Explore', 'Plan'],
  mcpServers: [{ name: 'github', instructions: 'Use the GitHub tools for issues.' }],
  deferredTools: ['WebFetch', 'NotebookEdit'],
  environment: { platform: 'darwin', cwd: '/Users/dev/repos/app' },
  weights: [
    { label: 'System prompt', tokens: 3000, estimated: false },
    { label: 'Memory files', tokens: 1200, estimated: true },
    { label: 'Empty', tokens: 0, estimated: false },
  ],
};

export const contextState: ContextState = {
  snapshot,
  sessions: [
    { id: 's1', title: 'Refactor parser' },
    { id: 's2', title: 'Write docs' },
  ],
};

export const knobDefinitions: readonly KnobDefinition[] = [
  {
    key: 'model',
    kind: 'setting',
    area: 'model',
    valueType: 'string',
    defaultValue: null,
    allowed: [],
    description: 'Default model for new sessions.',
    docUrl: 'https://code.claude.com/docs/settings',
    appliesAt: 'next-launch',
    managedOnly: false,
  },
  {
    key: 'alwaysThinkingEnabled',
    kind: 'setting',
    area: 'thinking',
    valueType: 'boolean',
    defaultValue: 'false',
    allowed: [],
    description: 'Think before every reply.',
    docUrl: 'https://code.claude.com/docs/settings',
    appliesAt: 'next-turn',
    managedOnly: false,
  },
  {
    key: 'BASH_MAX_OUTPUT_LENGTH',
    kind: 'env',
    area: 'bash',
    valueType: 'number',
    defaultValue: '30000',
    allowed: [],
    description: 'Max characters of shell output.',
    docUrl: 'https://code.claude.com/docs/env',
    appliesAt: 'next-launch',
    managedOnly: false,
  },
  {
    key: 'permissions.defaultMode',
    kind: 'setting',
    area: 'permissions',
    valueType: 'enum',
    defaultValue: 'default',
    allowed: ['default', 'acceptEdits', 'plan'],
    description: 'Starting permission mode.',
    docUrl: 'https://code.claude.com/docs/permissions',
    appliesAt: 'live',
    managedOnly: false,
  },
  {
    key: 'env',
    kind: 'setting',
    area: 'model',
    valueType: 'json',
    defaultValue: null,
    allowed: [],
    description: 'Extra environment variables.',
    docUrl: 'https://code.claude.com/docs/settings',
    appliesAt: 'next-launch',
    managedOnly: false,
  },
  {
    key: 'additionalDirectories',
    kind: 'setting',
    area: 'permissions',
    valueType: 'string[]',
    defaultValue: null,
    allowed: [],
    description: 'More folders Claude may read.',
    docUrl: 'https://code.claude.com/docs/settings',
    appliesAt: 'next-launch',
    managedOnly: true,
  },
];

export const knobsState: KnobsState = {
  catalog: knobDefinitions,
  effective: [
    {
      key: 'model',
      value: 'claude-opus-4-7',
      layer: 'project',
      chain: [
        { layer: 'project', value: 'claude-opus-4-7', file: '/repo/.claude/settings.json' },
        { layer: 'user', value: 'claude-sonnet-4-6', file: '/Users/dev/.claude/settings.json' },
      ],
    },
    {
      key: 'BASH_MAX_OUTPUT_LENGTH',
      value: 50_000,
      layer: 'env',
      chain: [{ layer: 'env', value: 50_000, file: null }],
    },
  ],
  profiles: [
    {
      id: 'p1',
      name: 'Fast',
      model: 'claude-sonnet-4-6',
      effort: 'low',
      permissionMode: 'acceptEdits',
      env: { BASH_MAX_OUTPUT_LENGTH: '10000' },
      extraArgs: ['--verbose'],
    },
    {
      id: 'p2',
      name: 'Deep',
      model: 'claude-opus-4-7',
      effort: 'high',
      permissionMode: null,
      env: {},
      extraArgs: [],
    },
  ],
  featureFlags: { beta_flag: true, rollout: { pct: 50 } },
};
