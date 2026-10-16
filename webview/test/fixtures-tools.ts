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
      handoffs: ['resume-local', 'start-cloud'],
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
  plan: null,
};
