import { describe, expect, it } from 'vitest';

import type { WorktreeSummary } from '../../shared/protocol.js';

import { buildWorkspaces, workspaceOfFile } from './workspaces.js';

const worktree: WorktreeSummary = {
  id: 'w1',
  kind: 'session',
  label: 'Session',
  repoRoot: '/repo',
  path: '/wt/w1',
  branch: 'overlord/w1',
  target: 'master',
  slot: 0,
  createdAt: 0,
  state: 'active',
  ahead: 0,
  dirty: 0,
  files: [],
  upstreamFiles: [],
  overlaps: [],
};

describe('workspaceOfFile', () => {
  it('picks the deepest workspace holding the file', () => {
    const all = buildWorkspaces(
      [worktree],
      [
        { sessionId: 'm', cwd: '/repo', topic: null, status: null, edited: [] },
        { sessionId: 'c', cwd: '/repo/.claude/worktrees/x', topic: null, status: null, edited: [] },
      ],
    );
    expect(workspaceOfFile('/repo/.claude/worktrees/x/a.ts', all)?.key).toBe(
      '/repo/.claude/worktrees/x',
    );
    expect(workspaceOfFile('/repo/a.ts', all)?.key).toBe('/repo');
    expect(workspaceOfFile('/elsewhere/a.ts', all)).toBeUndefined();
  });

  it('keeps edits outside the workspace out of its files', () => {
    const [only] = buildWorkspaces(
      [worktree],
      [
        {
          sessionId: 's',
          cwd: '/wt/w1',
          topic: null,
          status: null,
          edited: ['/tmp/x', '/wt/w1/y'],
        },
      ],
    );
    expect(only?.files).toStrictEqual(['y']);
  });
});
