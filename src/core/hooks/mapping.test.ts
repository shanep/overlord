import { describe, expect, it } from 'vitest';

import { ZERO_USAGE } from '../../shared/model.js';

import {
  agentIdOf,
  permissionOutput,
  preToolUseDenyOutput,
  ruleDenyMessage,
  toAgentNode,
  toInstructionLoaded,
  toPermissionRequest,
  withContext,
} from './mapping.js';
import type {
  InstructionsLoadedPayload,
  SubagentStartPayload,
  SubagentStopPayload,
} from './payloads.js';

function instruction(overrides: Partial<InstructionsLoadedPayload>): InstructionsLoadedPayload {
  return {
    session_id: 's1',
    hook_event_name: 'InstructionsLoaded',
    file_path: '/p/CLAUDE.md',
    memory_type: 'Project',
    load_reason: 'session_start',
    ...overrides,
  };
}

describe('agentIdOf', () => {
  it('falls back to the session id for the main thread', () => {
    expect(agentIdOf({ session_id: 's' })).toBe('s');
    expect(agentIdOf({ session_id: 's', agent_id: null })).toBe('s');
    expect(agentIdOf({ session_id: 's', agent_id: '' })).toBe('s');
    expect(agentIdOf({ session_id: 's', agent_id: 'a' })).toBe('a');
  });
});

describe('toInstructionLoaded', () => {
  it('maps every field', () => {
    expect(
      toInstructionLoaded(
        instruction({
          agent_id: 'a1',
          memory_type: 'User',
          load_reason: 'include',
          globs: ['**/*.ts'],
          trigger_file_path: '/p/a.ts',
          parent_file_path: '/p/CLAUDE.md',
        }),
        42,
      ),
    ).toStrictEqual({
      sessionId: 's1',
      agentId: 'a1',
      memoryType: 'User',
      instruction: {
        path: '/p/CLAUDE.md',
        tier: 'User',
        reason: 'include',
        triggerPath: '/p/a.ts',
        parentPath: '/p/CLAUDE.md',
        globs: ['**/*.ts'],
        bytes: 0,
        differsFromDisk: null,
        loadedAt: 42,
      },
    });
  });

  it('defaults optional fields', () => {
    const event = toInstructionLoaded(instruction({ globs: null, trigger_file_path: null }), 1);
    expect(event.agentId).toBe('s1');
    expect(event.instruction.globs).toStrictEqual([]);
    expect(event.instruction.triggerPath).toBeNull();
    expect(event.instruction.parentPath).toBeNull();
  });

  it.each(['Managed', 'User', 'Project', 'Local', 'AutoMem'])('keeps the %s tier', (tier) => {
    expect(toInstructionLoaded(instruction({ memory_type: tier }), 0).instruction.tier).toBe(tier);
  });

  it('falls back to Project for an unknown tier and keeps the raw value', () => {
    const event = toInstructionLoaded(instruction({ memory_type: 'Plugin' }), 0);
    expect(event.instruction.tier).toBe('Project');
    expect(event.memoryType).toBe('Plugin');
  });

  it.each(['session_start', 'nested_traversal', 'path_glob_match', 'include', 'compact'])(
    'keeps the %s reason',
    (reason) => {
      expect(toInstructionLoaded(instruction({ load_reason: reason }), 0).instruction.reason).toBe(
        reason,
      );
    },
  );

  it('maps an unknown reason to unknown', () => {
    expect(toInstructionLoaded(instruction({ load_reason: 'later' }), 0).instruction.reason).toBe(
      'unknown',
    );
  });
});

describe('toPermissionRequest', () => {
  it('builds a hook permission request', () => {
    expect(
      toPermissionRequest(
        {
          session_id: 's',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
        'req-1',
        99,
      ),
    ).toStrictEqual({
      id: 'req-1',
      sessionId: 's',
      agentId: 's',
      toolName: 'Bash',
      input: { command: 'ls' },
      requestedAt: 99,
      source: 'hook',
    });
  });
});

describe('toAgentNode', () => {
  const start: SubagentStartPayload = {
    session_id: 's',
    hook_event_name: 'SubagentStart',
    agent_id: 'a1',
    agent_type: 'Explore',
  };

  it('marks a started agent running', () => {
    expect(toAgentNode(start, { startedAt: 5, endedAt: null })).toStrictEqual({
      id: 'a1',
      sessionId: 's',
      parentAgentId: 's',
      parentToolUseId: null,
      agentType: 'Explore',
      description: '',
      spawnDepth: 1,
      background: false,
      state: 'running',
      startedAt: 5,
      endedAt: null,
      transcriptPath: null,
      usage: ZERO_USAGE,
      toolCallCount: 0,
      currentTool: null,
      model: null,
    });
  });

  it('marks a stopped agent done with its transcript', () => {
    const stop: SubagentStopPayload = {
      ...start,
      hook_event_name: 'SubagentStop',
      agent_transcript_path: '/t/agent-a1.jsonl',
    };
    const node = toAgentNode(stop, { startedAt: 5, endedAt: 9 });
    expect(node.state).toBe('done');
    expect(node.endedAt).toBe(9);
    expect(node.startedAt).toBe(5);
    expect(node.transcriptPath).toBe('/t/agent-a1.jsonl');
    expect(
      toAgentNode({ ...stop, agent_transcript_path: null }, { startedAt: 1, endedAt: 2 })
        .transcriptPath,
    ).toBeNull();
  });
});

describe('permissionOutput', () => {
  it('writes the documented allow shape', () => {
    expect(permissionOutput({ behavior: 'allow', ruleId: null })).toStrictEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('writes the documented deny shape with a message', () => {
    expect(permissionOutput({ behavior: 'deny', message: 'no', ruleId: 'r' })).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'no' },
      },
    });
  });
});

describe('ruleDenyMessage', () => {
  it('names the rule and its description', () => {
    expect(ruleDenyMessage('r1', '  never push  ')).toBe(
      'Denied by Overlord auto-approve rule r1: never push',
    );
    expect(ruleDenyMessage('r1', ' '.repeat(3))).toBe('Denied by Overlord auto-approve rule r1');
    expect(ruleDenyMessage('r2', '')).toBe('Denied by Overlord auto-approve rule r2');
  });
});

describe('preToolUseDenyOutput', () => {
  it('uses the documented PreToolUse deny shape', () => {
    expect(preToolUseDenyOutput('no messages to other sessions')).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'no messages to other sessions',
      },
    });
  });
});

describe('withContext', () => {
  it('leaves the output alone without text', () => {
    expect(withContext(null, 'SessionStart', null)).toBeNull();
    const deny = preToolUseDenyOutput('no');
    expect(withContext(deny, 'PreToolUse', null)).toBe(deny);
  });

  it('makes an output for the event when there was none', () => {
    expect(withContext(null, 'UserPromptSubmit', 'note')).toStrictEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'note' },
    });
    expect(withContext({ continue: true }, 'PostToolUse', 'note')).toStrictEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'note' },
    });
  });

  it('adds to the context already there, keeping the other fields', () => {
    const before = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'peers' },
    };
    expect(withContext(before, 'SessionStart', 'check')).toStrictEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'peers\n\ncheck' },
    });
    expect(withContext(preToolUseDenyOutput('no'), 'PreToolUse', 'check')).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'no',
        additionalContext: 'check',
      },
    });
  });
});
