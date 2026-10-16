import { describe, expect, it } from 'vitest';

import { KNOWN_EVENT_NAMES, knownPayloadSchema, parseHookPayload } from './payloads.js';

function byName(left: string, right: string): number {
  return left.localeCompare(right);
}

const common = {
  session_id: 'sess-1',
  transcript_path: '/home/u/.claude/projects/p/sess-1.jsonl',
  cwd: '/home/u/project',
  permission_mode: 'default',
};

const samples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  PreToolUse: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' },
  PostToolUse: {
    tool_name: 'Write',
    tool_input: { file_path: '/a.txt', content: 'x' },
    tool_response: { filePath: '/a.txt' },
    tool_use_id: 'toolu_2',
    duration_ms: 12,
  },
  PostToolUseFailure: {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: 'toolu_3',
    error: 'Exit code 1',
    is_interrupt: false,
    duration_ms: 4187,
  },
  UserPromptSubmit: { prompt: 'hello', session_title: null },
  SessionStart: { source: 'startup', model: 'claude-opus-5' },
  SessionEnd: { reason: 'other' },
  Stop: { stop_hook_active: false, last_assistant_message: 'done' },
  SubagentStart: { agent_id: 'agent-1', agent_type: 'Explore' },
  SubagentStop: {
    agent_id: 'agent-1',
    agent_type: 'Explore',
    stop_hook_active: false,
    agent_transcript_path: '/t/subagents/agent-1.jsonl',
    last_assistant_message: 'found it',
  },
  PreCompact: { trigger: 'manual', custom_instructions: null },
  PostCompact: { trigger: 'auto', compact_summary: 'summary' },
  Notification: {
    message: 'needs you',
    title: 'Permission',
    notification_type: 'permission_prompt',
  },
  PermissionRequest: {
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf node_modules' },
    permission_suggestions: [{ type: 'addRules' }],
  },
  PermissionDenied: {
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /tmp/x' },
    tool_use_id: 'toolu_4',
    reason: '[Irreversible Local Destruction]',
  },
  InstructionsLoaded: {
    file_path: '/p/CLAUDE.md',
    memory_type: 'Project',
    load_reason: 'path_glob_match',
    globs: ['src/**'],
    trigger_file_path: '/p/src/a.ts',
    parent_file_path: null,
  },
};

describe('parseHookPayload', () => {
  it('lists exactly the events the schema models', () => {
    expect(KNOWN_EVENT_NAMES).toHaveLength(15);
    expect(Object.keys(samples).toSorted(byName)).toStrictEqual(
      [...KNOWN_EVENT_NAMES].toSorted(byName),
    );
    expect(
      [...knownPayloadSchema.options.map((option) => option.shape.hook_event_name.value)].toSorted(
        byName,
      ),
    ).toStrictEqual([...KNOWN_EVENT_NAMES].toSorted(byName));
  });

  it.each(Object.entries(samples))('parses %s as a known event', (name, fields) => {
    const result = parseHookPayload({ ...common, hook_event_name: name, ...fields });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.known).toBe(true);
    expect(result.value.payload.hook_event_name).toBe(name);
    expect(result.value.payload.session_id).toBe('sess-1');
    expect(result.value.payload.cwd).toBe('/home/u/project');
  });

  it('keeps the event specific fields of InstructionsLoaded', () => {
    const result = parseHookPayload({
      ...common,
      hook_event_name: 'InstructionsLoaded',
      ...samples['InstructionsLoaded'],
    });
    expect(result).toStrictEqual({
      ok: true,
      value: {
        known: true,
        payload: {
          ...common,
          hook_event_name: 'InstructionsLoaded',
          file_path: '/p/CLAUDE.md',
          memory_type: 'Project',
          load_reason: 'path_glob_match',
          globs: ['src/**'],
          trigger_file_path: '/p/src/a.ts',
          parent_file_path: null,
        },
      },
    });
  });

  it('keeps fields Claude Code adds that we do not model', () => {
    const result = parseHookPayload({
      ...common,
      hook_event_name: 'Stop',
      background_tasks: [{ id: 't1' }],
      effort: { level: 'high' },
    });
    expect(result.ok && result.value.known).toBe(true);
    expect(result.ok ? result.value.payload : null).toMatchObject({
      background_tasks: [{ id: 't1' }],
      effort: { level: 'high' },
    });
  });

  it('parses an event it does not model to the common shape', () => {
    const result = parseHookPayload({
      session_id: 's',
      hook_event_name: 'TaskCreated',
      task_id: 'task-1',
      agent_id: 'a1',
      agent_type: 'Plan',
    });
    expect(result).toStrictEqual({
      ok: true,
      value: {
        known: false,
        payload: {
          session_id: 's',
          hook_event_name: 'TaskCreated',
          task_id: 'task-1',
          agent_id: 'a1',
          agent_type: 'Plan',
        },
      },
    });
  });

  it('treats a known event with an unexpected shape as unknown', () => {
    const result = parseHookPayload({ session_id: 's', hook_event_name: 'PermissionRequest' });
    expect(result).toStrictEqual({
      ok: true,
      value: { known: false, payload: { session_id: 's', hook_event_name: 'PermissionRequest' } },
    });
  });

  it('rejects payloads without the common fields', () => {
    const missing = parseHookPayload({ hook_event_name: 'Stop' });
    expect(missing.ok).toBe(false);
    expect(missing.ok ? '' : missing.error).toContain('session_id');
    const wrongType = parseHookPayload({ session_id: 1, hook_event_name: 'Stop' });
    expect(wrongType.ok).toBe(false);
    expect(parseHookPayload(null).ok).toBe(false);
    expect(parseHookPayload('Stop').ok).toBe(false);
  });

  it('rejects a common field with the wrong type', () => {
    const result = parseHookPayload({ session_id: 's', hook_event_name: 'Stop', cwd: 5 });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('cwd');
  });
});
