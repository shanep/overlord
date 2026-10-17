import { describe, expect, it } from 'vitest';

import type { WorktreeSummary } from '../../shared/protocol.js';
import { claudeHooks } from '../agents/claude/hooks.js';
import { applyPatchPaths } from '../hooks/apply-patch.js';
import type { EditTools } from '../hooks/normalized.js';
import type { KnownPayload } from '../hooks/payloads.js';
import type { HookOutput } from '../hooks/protocol.js';

import type { CoordinatorDeps } from './coordinator.js';
import { Coordinator, QUIET_MS } from './coordinator.js';

function worktree(overrides: Partial<WorktreeSummary> & { readonly id: string }): WorktreeSummary {
  return {
    kind: 'session',
    label: `Session ${overrides.id}`,
    repoRoot: '/repo',
    path: `/wt/${overrides.id}`,
    branch: `overlord/${overrides.id}`,
    target: 'master',
    slot: 0,
    createdAt: 0,
    state: 'active',
    ahead: 0,
    dirty: 0,
    files: [],
    upstreamFiles: [],
    overlaps: [],
    ...overrides,
  };
}

interface World {
  worktrees: WorktreeSummary[];
  enabled: boolean;
  now: number;
  live: Set<string>;
  refreshes: number;
}

/** The coordinator as a Claude Code hook sees it: Claude's payload in, Claude's JSON out. */
interface ClaudeSide {
  handle: (payload: KnownPayload) => HookOutput | null;
}

function claudeSide(coordinator: Coordinator): ClaudeSide {
  return {
    handle: (payload): HookOutput | null => {
      const result = claudeHooks.normalize({ payload, name: null });
      if (!result.ok) {
        throw new Error(result.error);
      }
      const answer = coordinator.handle(result.event);
      return answer === null ? null : claudeHooks.answer(result.event, answer);
    },
  };
}

function setUp(
  worktrees: WorktreeSummary[],
  editTools: EditTools = claudeHooks.editTools,
): { world: World; coordinator: ClaudeSide } {
  const world: World = { worktrees, enabled: true, now: 0, live: new Set(), refreshes: 0 };
  const deps: CoordinatorDeps = {
    enabled: () => world.enabled,
    worktrees: () => world.worktrees,
    statuses: () => ({ b: 'busy' }),
    isLive: (sessionId) => world.live.has(sessionId),
    refresh: () => {
      world.refreshes += 1;
    },
    now: () => world.now,
    editTools: () => editTools,
  };
  return { world, coordinator: claudeSide(new Coordinator(deps)) };
}

function start(session: string, cwd: string, title: string | null = null): KnownPayload {
  return {
    session_id: session,
    hook_event_name: 'SessionStart',
    cwd,
    source: 'startup',
    session_title: title,
  };
}

function prompt(session: string, cwd: string, text: string): KnownPayload {
  return { session_id: session, hook_event_name: 'UserPromptSubmit', cwd, prompt: text };
}

function edit(session: string, cwd: string, file: string, tool = 'Edit'): KnownPayload {
  return {
    session_id: session,
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: tool,
    tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
  };
}

function edited(session: string, cwd: string, input: unknown, tool = 'Write'): KnownPayload {
  return {
    session_id: session,
    hook_event_name: 'PostToolUse',
    cwd,
    tool_name: tool,
    tool_input: input,
    tool_response: {},
  };
}

function contextOf(output: HookOutput | null): string {
  const specific = output?.['hookSpecificOutput'];
  if (typeof specific !== 'object' || specific === null || !('additionalContext' in specific)) {
    throw new Error(`no context in ${JSON.stringify(output)}`);
  }
  return String(specific.additionalContext);
}

function denyReason(output: HookOutput | null): string {
  const specific = output?.['hookSpecificOutput'];
  if (
    typeof specific !== 'object' ||
    specific === null ||
    !('permissionDecision' in specific) ||
    specific.permissionDecision !== 'deny' ||
    !('permissionDecisionReason' in specific)
  ) {
    throw new Error(`not a deny: ${JSON.stringify(output)}`);
  }
  return String(specific.permissionDecisionReason);
}

describe('Coordinator', () => {
  describe('telling a session who else is here', () => {
    it('lists the other sessions and their files when a session starts', () => {
      const { coordinator } = setUp([
        worktree({ id: 'a' }),
        worktree({ id: 'b', files: ['src/x.ts'] }),
        worktree({ id: 'c', state: 'unlanded', label: 'Old work', files: ['README.md'] }),
        worktree({ id: 'd', state: 'landed', files: ['gone.ts'] }),
        worktree({ id: 'e', repoRoot: '/other', files: ['src/x.ts'] }),
      ]);
      coordinator.handle(prompt('b', '/wt/b', 'Fix the parser\nand more'));
      const output = coordinator.handle(start('a', '/wt/a'));
      const text = contextOf(output);
      expect(output).toMatchObject({ hookSpecificOutput: { hookEventName: 'SessionStart' } });
      expect(text).toContain('- "Fix the parser" (busy) in branch overlord/b, changing src/x.ts');
      expect(text).toContain(
        '- Unlanded work "Old work" with no session open in branch overlord/c, changing README.md',
      );
      expect(text).not.toContain('gone.ts');
      expect(text).not.toContain('/other');
    });

    it('says nothing when the session is alone or outside a known repository', () => {
      const { coordinator } = setUp([worktree({ id: 'a' })]);
      expect(coordinator.handle(start('a', '/wt/a'))).toBeNull();
      expect(coordinator.handle(start('x', '/elsewhere'))).toBeNull();
      expect(coordinator.handle({ ...start('y', ''), cwd: null })).toBeNull();
    });

    it('repeats the list on a prompt only when who is there changed', () => {
      const { world, coordinator } = setUp([worktree({ id: 'a' }), worktree({ id: 'b' })]);
      expect(contextOf(coordinator.handle(start('a', '/wt/a')))).toContain('A session in');
      expect(coordinator.handle(prompt('a', '/wt/a', 'go'))).toBeNull();
      world.worktrees = [...world.worktrees, worktree({ id: 'c', files: ['c.ts'] })];
      const text = contextOf(coordinator.handle(prompt('a', '/wt/a', 'again')));
      expect(text).toContain('changing c.ts');
      world.worktrees = world.worktrees.map((item) =>
        item.id === 'c' ? { ...item, files: ['c.ts', 'd.ts'] } : item,
      );
      expect(coordinator.handle(prompt('a', '/wt/a', 'once more'))).toBeNull();
    });

    it('names sessions by title over prompt and folds in sessions outside Overlord worktrees', () => {
      const { coordinator } = setUp([worktree({ id: 'a' })]);
      coordinator.handle(start('m', '/repo/src', 'Docs pass'));
      coordinator.handle(prompt('m', '/repo/src', 'ignored, the title wins'));
      coordinator.handle(edited('m', '/repo/src', { file_path: 'notes.md' }));
      coordinator.handle(start('c', '/repo/.claude/worktrees/feature/sub'));
      coordinator.handle(start('t', '/repo/.claude/worktrees/top'));
      const text = contextOf(coordinator.handle(start('a', '/wt/a')));
      expect(text).toContain('- "Docs pass" in /repo, changing src/notes.md');
      expect(text).toContain('- A session in /repo/.claude/worktrees/feature, no changes yet');
      expect(text).toContain('- A session in /repo/.claude/worktrees/top, no changes yet');
    });

    it('caps long lists', () => {
      const files = Array.from({ length: 10 }, (_, index) => `f${String(index)}.ts`);
      const others = Array.from({ length: 10 }, (_, index) =>
        worktree({ id: `p${String(index)}`, files }),
      );
      const { coordinator } = setUp([worktree({ id: 'a' }), ...others]);
      const text = contextOf(coordinator.handle(start('a', '/wt/a')));
      expect(text).toContain('f7.ts and 2 more');
      expect(text).toContain('- and 2 more');
    });

    it('stays quiet when turned off', () => {
      const { world, coordinator } = setUp([worktree({ id: 'a' }), worktree({ id: 'b' })]);
      world.enabled = false;
      expect(coordinator.handle(start('a', '/wt/a'))).toBeNull();
    });
  });

  describe('pausing a clashing edit', () => {
    it('pauses the first edit to a file another session changes, then lets it through', () => {
      const { coordinator } = setUp([
        worktree({ id: 'a' }),
        worktree({ id: 'b', files: ['src/x.ts'] }),
      ]);
      coordinator.handle(start('a', '/wt/a'));
      const reason = denyReason(coordinator.handle(edit('a', '/wt/a', '/wt/a/src/x.ts')));
      expect(reason).toContain('also changing src/x.ts');
      expect(reason).toContain('- A session in branch overlord/b, changing src/x.ts');
      expect(reason).toContain('make the same edit again');
      expect(coordinator.handle(edit('a', '/wt/a', '/wt/a/src/x.ts'))).toBeNull();
      expect(coordinator.handle(edit('a', '/wt/a', 'src/y.ts'))).toBeNull();
    });

    it('pauses again when a new session starts changing the same file', () => {
      const { world, coordinator } = setUp([
        worktree({ id: 'a' }),
        worktree({ id: 'b', files: ['x.ts'] }),
      ]);
      coordinator.handle(start('a', '/wt/a'));
      denyReason(coordinator.handle(edit('a', '/wt/a', 'x.ts')));
      world.worktrees = [...world.worktrees, worktree({ id: 'c', files: ['x.ts'] })];
      expect(denyReason(coordinator.handle(edit('a', '/wt/a', 'x.ts', 'MultiEdit')))).toContain(
        'branch overlord/c',
      );
    });

    it("sees another session's edit before git status catches up", () => {
      const { coordinator } = setUp([worktree({ id: 'a' }), worktree({ id: 'b' })]);
      coordinator.handle(start('a', '/wt/a'));
      coordinator.handle(start('b', '/wt/b'));
      coordinator.handle(edited('b', '/wt/b', { notebook_path: '/wt/b/nb.ipynb' }, 'NotebookEdit'));
      coordinator.handle(edited('b', '/wt/b', { file_path: '' }));
      coordinator.handle(edited('b', '/wt/b', { command: 'ls' }, 'Bash'));
      const reason = denyReason(
        coordinator.handle({
          ...edit('a', '/wt/a', ''),
          tool_name: 'NotebookEdit',
          tool_input: { notebook_path: 'nb.ipynb' },
        }),
      );
      expect(reason).toContain('nb.ipynb');
    });

    it('reads the files of a patch from its headers', () => {
      const tools: EditTools = { ...claudeHooks.editTools, apply_patch: applyPatchPaths };
      const { coordinator } = setUp([worktree({ id: 'a' }), worktree({ id: 'b' })], tools);
      coordinator.handle(start('a', '/wt/a'));
      coordinator.handle(start('b', '/wt/b'));
      const patch = '*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** End Patch';
      coordinator.handle(edited('b', '/wt/b', { command: patch }, 'apply_patch'));
      const both = {
        ...edit('a', '/wt/a', ''),
        tool_name: 'apply_patch',
        tool_input: { command: `*** Begin Patch\n*** Add File: y.ts\n${patch}` },
      };
      expect(denyReason(coordinator.handle(both))).toContain('also changing src/x.ts');
      expect(coordinator.handle(both)).toBeNull();
    });

    it('ignores other tools, unknown sessions and files outside the workspace', () => {
      const { coordinator } = setUp([
        worktree({ id: 'a' }),
        worktree({ id: 'b', files: ['x.ts'] }),
      ]);
      expect(coordinator.handle(edit('a', '/wt/a', 'x.ts', 'Read'))).toBeNull();
      expect(
        coordinator.handle({ ...edit('a', '/wt/a', 'x.ts'), tool_input: { file_path: 7 } }),
      ).toBeNull();
      expect(coordinator.handle(edit('z', '/nowhere', '/nowhere/x.ts'))).toBeNull();
      expect(coordinator.handle(edit('a', '/wt/a', '/tmp/x.ts'))).toBeNull();
    });

    it('forgets what it paused when the session ends', () => {
      const { coordinator } = setUp([
        worktree({ id: 'a' }),
        worktree({ id: 'b', files: ['x.ts'] }),
        worktree({ id: 'c' }),
      ]);
      denyReason(coordinator.handle(edit('a', '/wt/a', 'x.ts')));
      denyReason(coordinator.handle(edit('c', '/wt/c', 'x.ts')));
      coordinator.handle({ session_id: 'a', hook_event_name: 'SessionEnd', reason: 'exit' });
      expect(coordinator.handle(edit('c', '/wt/c', 'x.ts'))).toBeNull();
      expect(denyReason(coordinator.handle(edit('a', '/wt/a', 'x.ts')))).toContain('x.ts');
    });
  });

  describe('passing on new commits on the default branch', () => {
    it('tells the main thread once per file and again after a rebase clears them', () => {
      const { world, coordinator } = setUp([
        worktree({ id: 'a', files: ['x.ts', 'y.ts'], upstreamFiles: ['x.ts'] }),
      ]);
      const post = edited('a', '/wt/a', { command: 'ls' }, 'Bash');
      const output = coordinator.handle(post);
      expect(output).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse' } });
      const text = contextOf(output);
      expect(text).toContain('new commits landed on master that change files');
      expect(text).toContain('git fetch origin master && git rebase origin/master');
      expect(coordinator.handle(post)).toBeNull();
      world.worktrees = [
        worktree({ id: 'a', files: ['x.ts', 'y.ts'], upstreamFiles: ['x.ts', 'y.ts'] }),
      ];
      expect(contextOf(coordinator.handle(prompt('a', '/wt/a', 'next')))).toContain(': y.ts.');
      world.worktrees = [worktree({ id: 'a', files: ['x.ts'] })];
      expect(coordinator.handle(post)).toBeNull();
      world.worktrees = [worktree({ id: 'a', files: ['x.ts'], upstreamFiles: ['x.ts'] })];
      expect(contextOf(coordinator.handle(post))).toContain(': x.ts.');
    });

    it('holds the notice back from subagents and from repositories with no origin', () => {
      const { world, coordinator } = setUp([
        worktree({ id: 'a', files: ['x.ts'], upstreamFiles: ['x.ts'] }),
      ]);
      expect(
        coordinator.handle({ ...edited('a', '/wt/a', { command: 'ls' }, 'Bash'), agent_id: 'sub' }),
      ).toBeNull();
      world.worktrees = [
        worktree({ id: 'a', target: null, files: ['x.ts'], upstreamFiles: ['x.ts'] }),
      ];
      expect(coordinator.handle(edited('a', '/wt/a', { command: 'ls' }, 'Bash'))).toBeNull();
    });

    it('asks for fresh worktree status when a session pushes', () => {
      const { world, coordinator } = setUp([worktree({ id: 'a' })]);
      coordinator.handle(edited('a', '/wt/a', { command: 'git push origin HEAD:master' }, 'Bash'));
      coordinator.handle(edited('a', '/wt/a', { command: 'git -C /x push' }, 'Bash'));
      coordinator.handle(edited('a', '/wt/a', { command: 'git status; echo push' }, 'Bash'));
      expect(world.refreshes).toBe(2);
    });
  });

  it('drops sessions gone quiet with no process, and keeps live ones', () => {
    const { world, coordinator } = setUp([worktree({ id: 'a' })]);
    coordinator.handle(start('q', '/repo', 'Quiet one'));
    coordinator.handle(start('l', '/repo/.claude/worktrees/live', 'Live one'));
    world.live.add('l');
    world.now = QUIET_MS + 1;
    const text = contextOf(coordinator.handle(start('a', '/wt/a')));
    expect(text).toContain('Live one');
    expect(text).not.toContain('Quiet one');
  });

  it('answers no other events', () => {
    const { coordinator } = setUp([worktree({ id: 'a' }), worktree({ id: 'b' })]);
    expect(
      coordinator.handle({ session_id: 'a', hook_event_name: 'Stop', cwd: '/wt/a' }),
    ).toBeNull();
  });
});
