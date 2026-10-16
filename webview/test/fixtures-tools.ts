// Launcher, sessions, config and usage fixtures.

import type { ConfigItem } from '../../src/shared/model.js';
import type {
  ConfigState,
  LauncherState,
  SessionsState,
  UsageState,
} from '../../src/shared/protocol.js';

import { knobsState } from './fixtures-context.js';
import { NOW, permission } from './fixtures.js';

const MINUTE = 60_000;

export const launcherState: LauncherState = {
  runs: [
    {
      id: 'r1',
      batchId: 'b1',
      spec: {
        prompt: 'Fix the flaky test',
        cwd: '/repo',
        profileId: 'p1',
        worktree: true,
        maxBudgetUsd: 2,
        label: 'Flaky test',
      },
      sessionId: 's9',
      state: 'running',
      costUsd: 0.3,
      turns: 4,
      durationMs: 95_000,
      result: null,
      worktreePath: '/repo/.worktrees/r1',
    },
    {
      id: 'r2',
      batchId: 'b1',
      spec: {
        prompt: 'Fix the flaky test',
        cwd: '/repo',
        profileId: null,
        worktree: false,
        maxBudgetUsd: null,
        label: 'Flaky test',
      },
      sessionId: null,
      state: 'done',
      costUsd: 0.8,
      turns: 9,
      durationMs: 300_000,
      result: 'Fixed by adding a wait.',
      worktreePath: null,
    },
  ],
  profiles: knobsState.profiles,
  drafts: [{ id: 'd1', label: 'Review', prompt: 'Review the last commit.' }],
  pendingPermissions: [permission],
  rules: [
    {
      id: 'rule-1',
      enabled: true,
      behavior: 'allow',
      tool: 'Read',
      pattern: null,
      description: 'Reads are safe',
    },
    {
      id: 'rule-2',
      enabled: false,
      behavior: 'deny',
      tool: 'Bash',
      pattern: 'rm *',
      description: 'No deletes',
    },
  ],
  maxConcurrency: 4,
  defaultFolder: '/work',
  worktrees: [
    {
      id: 'w1',
      kind: 'run',
      label: 'Flaky test',
      repoRoot: '/repo',
      path: '/home/me/.overlord/worktrees/repo-1a2b3c4d/w1',
      branch: 'overlord/w1',
      target: 'main',
      slot: 0,
      createdAt: NOW - 10 * MINUTE,
      state: 'active',
      ahead: 0,
      dirty: 1,
      files: ['src/parser.ts'],
      overlaps: [{ id: 'w2', label: 'Parser cleanup', files: ['src/parser.ts'] }],
    },
    {
      id: 'w2',
      kind: 'session',
      label: 'Parser cleanup',
      repoRoot: '/repo',
      path: '/home/me/.overlord/worktrees/repo-1a2b3c4d/w2',
      branch: 'overlord/w2',
      target: 'main',
      slot: 1,
      createdAt: NOW - 30 * MINUTE,
      state: 'unlanded',
      ahead: 2,
      dirty: 0,
      files: ['src/parser.ts', 'src/lexer.ts'],
      overlaps: [{ id: 'w1', label: 'Flaky test', files: ['src/parser.ts'] }],
    },
    {
      id: 'w3',
      kind: 'session',
      label: 'Docs pass',
      repoRoot: '/docs',
      path: '/home/me/.overlord/worktrees/docs-5e6f7a8b/w3',
      branch: 'overlord/w3',
      target: null,
      slot: 2,
      createdAt: NOW - 60 * MINUTE,
      state: 'dirty',
      ahead: 1,
      dirty: 3,
      files: ['README.md'],
      overlaps: [],
    },
  ],
};

export const sessionsState: SessionsState = {
  sessions: [
    {
      id: 'x1',
      surface: 'cli',
      title: 'Refactor parser',
      cwd: '/repo',
      updatedAt: NOW - 5 * MINUTE,
      archived: false,
      handoffs: ['resume-local', 'remote-control'],
    },
    {
      id: 'x2',
      surface: 'cloud',
      title: 'Cloud fix',
      cwd: null,
      updatedAt: NOW - 3 * 60 * MINUTE,
      archived: false,
      handoffs: ['teleport-local'],
    },
    {
      id: 'x3',
      surface: 'claude-ai',
      title: 'Chat about tests',
      cwd: null,
      updatedAt: NOW - 2 * 24 * 60 * MINUTE,
      archived: true,
      handoffs: [],
    },
  ],
  claudeAiImportedAt: NOW - 24 * 60 * MINUTE,
  projects: {},
};

function configItem(overrides: Partial<ConfigItem> & { id: string }): ConfigItem {
  return {
    kind: 'skill',
    name: overrides.id,
    scope: 'user',
    path: `/Users/dev/.claude/skills/${overrides.id}`,
    realPath: null,
    status: 'versioned',
    repo: null,
    ...overrides,
  };
}

export const configState: ConfigState = {
  items: [
    configItem({ id: 'claude-md', kind: 'claude-md', name: 'CLAUDE.md', status: 'modified' }),
    configItem({ id: 'writing-voice' }),
    configItem({
      id: 'canvas',
      status: 'external-repo',
      realPath: '/Users/dev/repos/edutools/skill',
    }),
    configItem({ id: 'memory', kind: 'memory', status: 'local-only' }),
    configItem({ id: 'explore', kind: 'agent', scope: 'built-in', status: 'built-in', path: null }),
    configItem({ id: 'github', kind: 'mcp-server', status: 'secret' }),
  ],
  repo: {
    connected: true,
    remote: 'git@github.com:dev/claude-config.git',
    path: '/Users/dev/claude-config',
    ahead: 2,
    behind: 1,
    dirty: 3,
  },
  sync: { state: 'idle', lastSyncAt: null, message: null },
};

export const usageState: UsageState = {
  days: [
    {
      date: '2026-10-14',
      messages: 120,
      sessions: 6,
      toolCalls: 300,
      tokensByModel: { 'claude-opus-4-7': 500_000, 'claude-sonnet-4-6': 120_000 },
    },
    {
      date: '2026-10-13',
      messages: 80,
      sessions: 4,
      toolCalls: 150,
      tokensByModel: { 'claude-opus-4-7': 300_000 },
    },
  ],
  hourCounts: { '9': 12, '10': 30, '14': 8 },
  totalSessions: 10,
  totalMessages: 200,
  climate: {
    energyKwh: 12.5,
    co2eKg: 5,
    waterLiters: 22.5,
    drivingMiles: 12.5,
    homeDays: 0.431,
    unpricedTokens: 0,
    models: [
      { model: 'claude-opus-4-7', tokens: 800_000, energyKwh: 12, co2eKg: 4.8 },
      { model: 'claude-sonnet-4-6', tokens: 120_000, energyKwh: 0.5, co2eKg: 0.2 },
    ],
    assumptions: {
      whPerListDollar: 40,
      kgCo2ePerKwh: 0.4,
      litersPerKwh: 1.8,
      kgCo2ePerMile: 0.4,
      kwhPerHomeDay: 29,
    },
  },
  plan: null,
};
