import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NormalizedHookEvent } from '../../hooks/normalized.js';
import { claudeEvent } from '../../hooks/test-helpers/claude-hook.js';

import { answerClaudeHook, claudeHooks, normalizeClaudeHook } from './hooks.js';

const base = { session_id: 's', cwd: '/w', transcript_path: '/t.jsonl' };
const common = {
  agent: 'claude-code',
  sessionId: 's',
  subagentId: null,
  cwd: '/w',
  transcriptPath: '/t.jsonl',
  timestamp: null,
};
const bash = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1' };
const call = { name: 'Bash', input: { command: 'ls' }, useId: 'tu1' };

describe('normalizeClaudeHook', () => {
  it.each<[Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>]>([
    [
      { hook_event_name: 'SessionStart', source: 'startup', model: 'm', session_title: 'T' },
      { kind: 'session-start', source: 'new', model: 'm', title: 'T' },
    ],
    [
      { hook_event_name: 'SessionStart', source: 'later' },
      { kind: 'session-start', source: 'other', model: null, title: null },
    ],
    [
      { hook_event_name: 'SessionEnd', reason: 'exit' },
      { kind: 'session-end', reason: 'exit' },
    ],
    [
      { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      { kind: 'prompt-submit', prompt: 'go', title: null },
    ],
    [
      { hook_event_name: 'PreToolUse', ...bash },
      { kind: 'pre-tool-use', tool: call },
    ],
    [
      { hook_event_name: 'PostToolUse', ...bash, tool_response: { ok: 1 } },
      { kind: 'post-tool-use', tool: call, response: { ok: 1 } },
    ],
    [
      { hook_event_name: 'PostToolUseFailure', ...bash, error: 'no' },
      { kind: 'tool-failed', tool: call, error: 'no' },
    ],
    [
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} },
      { kind: 'permission-request', tool: { name: 'Bash', input: {}, useId: null } },
    ],
    [
      { hook_event_name: 'PermissionDenied', ...bash },
      { kind: 'permission-denied', tool: call, reason: null },
    ],
    [
      { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
      { kind: 'subagent-start', subagentId: 'a1', subagent: { id: 'a1', type: 'Explore' } },
    ],
    [
      {
        hook_event_name: 'SubagentStop',
        agent_id: 'a1',
        agent_type: 'Explore',
        agent_transcript_path: '/a1.jsonl',
      },
      {
        kind: 'subagent-stop',
        subagentId: 'a1',
        subagent: { id: 'a1', type: 'Explore' },
        subagentTranscriptPath: '/a1.jsonl',
      },
    ],
    [
      { hook_event_name: 'Stop', last_assistant_message: 'done' },
      { kind: 'stop', lastMessage: 'done' },
    ],
    [
      { hook_event_name: 'PreCompact', trigger: 'auto' },
      { kind: 'compaction', phase: 'before', trigger: 'auto' },
    ],
    [
      { hook_event_name: 'PostCompact', trigger: 'manual' },
      { kind: 'compaction', phase: 'after', trigger: 'manual' },
    ],
    [
      { hook_event_name: 'Notification', message: 'hi', title: 'T' },
      { kind: 'notification', message: 'hi', title: 'T' },
    ],
    [
      {
        hook_event_name: 'InstructionsLoaded',
        file_path: '/w/CLAUDE.md',
        memory_type: 'Project',
        load_reason: 'session_start',
      },
      {
        kind: 'instructions-loaded',
        file: '/w/CLAUDE.md',
        memoryType: 'Project',
        loadReason: 'session_start',
        globs: [],
        triggerPath: null,
        parentPath: null,
      },
    ],
    [{ hook_event_name: 'TaskCreated' }, { kind: 'other' }],
    [{ hook_event_name: 'PreToolUse' }, { kind: 'other' }],
  ])('reads %o', (payload, expected) => {
    const event = claudeEvent({ ...base, ...payload });
    expect(event).toStrictEqual({ ...common, native: payload['hook_event_name'], ...expected });
  });

  it('keeps the subagent a hook fired in', () => {
    expect(
      claudeEvent({ ...base, hook_event_name: 'Stop', agent_id: 'a2', cwd: null }),
    ).toMatchObject({ subagentId: 'a2', cwd: null });
  });

  it('reports a payload without a session id', () => {
    const result = normalizeClaudeHook({ payload: { hook_event_name: 'Stop' }, name: 'Stop' });
    expect(result.ok).toBe(false);
  });
});

describe('answerClaudeHook', () => {
  const prompt = claudeEvent({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  const pre: NormalizedHookEvent = claudeEvent({ ...base, hook_event_name: 'PreToolUse', ...bash });

  it('writes nothing for an empty answer', () => {
    expect(answerClaudeHook(prompt, {})).toStrictEqual({});
  });

  it('writes a decision in the PermissionRequest shape', () => {
    expect(
      answerClaudeHook(prompt, { decision: { behavior: 'allow', ruleId: null } }),
    ).toStrictEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('writes context for the event and the notice as the systemMessage', () => {
    expect(answerClaudeHook(prompt, { context: 'peers', notice: 'seen' })).toStrictEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'peers' },
      systemMessage: 'seen',
    });
  });

  it('writes a block as a PreToolUse deny, with any context beside it', () => {
    expect(answerClaudeHook(pre, { block: 'busy', context: 'note' })).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'busy',
        additionalContext: 'note',
      },
    });
  });
});

describe('claudeHooks', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-claude-hooks-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs into settings.json in the config folder and takes it out again', async () => {
    const dirs = { home: dir, configDir: dir };
    expect(await claudeHooks.installed(dirs)).toBe(false);
    expect(await claudeHooks.install(dirs, 'node overlord-hook.cjs')).toStrictEqual({
      changed: true,
    });
    expect(await claudeHooks.installed(dirs)).toBe(true);
    const text = await readFile(path.join(dir, 'settings.json'), 'utf8');
    expect(text).toContain('node overlord-hook.cjs');
    expect(await claudeHooks.uninstall(dirs)).toStrictEqual({ changed: true });
    expect(await claudeHooks.installed(dirs)).toBe(false);
  });

  it('names the file tools the coordinator watches', () => {
    expect(Object.keys(claudeHooks.editTools)).toStrictEqual([
      'Edit',
      'Write',
      'MultiEdit',
      'NotebookEdit',
    ]);
    expect(claudeHooks.editTools['Edit']).toStrictEqual(['file_path', 'notebook_path']);
  });
});
