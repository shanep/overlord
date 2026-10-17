import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { editedFiles, type NormalizedHookEvent } from '../../hooks/normalized.js';
import type { AgentDirs } from '../types.js';

import {
  answerCodexHook,
  CODEX_HOOK_EVENTS,
  codexHooks,
  codexHookTimeout,
  normalizeCodexHook,
} from './hooks.js';

const base = { session_id: 'thr', cwd: '/w', transcript_path: '/t.jsonl', model: 'gpt-6-luna' };
const common = {
  agent: 'codex',
  sessionId: 'thr',
  subagentId: null,
  cwd: '/w',
  transcriptPath: '/t.jsonl',
  timestamp: null,
};
const bash = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'call_1' };
const call = { name: 'Bash', input: { command: 'ls' }, useId: 'call_1' };

function normalized(payload: Readonly<Record<string, unknown>>): NormalizedHookEvent {
  const result = normalizeCodexHook({ payload: { ...base, ...payload }, name: null });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.event;
}

describe('normalizeCodexHook', () => {
  it.each<[Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>]>([
    [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { kind: 'session-start', source: 'new', model: 'gpt-6-luna', title: null },
    ],
    [
      { hook_event_name: 'SessionStart', source: 'fork' },
      { kind: 'session-start', source: 'fork' },
    ],
    [
      { hook_event_name: 'SessionStart', source: 'later' },
      { kind: 'session-start', source: 'other' },
    ],
    [
      { hook_event_name: 'SessionEnd', reason: 'other' },
      { kind: 'session-end', reason: 'other' },
    ],
    [
      { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' },
      { kind: 'prompt-submit', prompt: 'go', title: null },
    ],
    [
      { hook_event_name: 'PreToolUse', ...bash },
      { kind: 'pre-tool-use', tool: call },
    ],
    [
      { hook_event_name: 'PostToolUse', ...bash, tool_response: 'out' },
      { kind: 'post-tool-use', tool: call, response: 'out' },
    ],
    [
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm x' } },
      {
        kind: 'permission-request',
        tool: { name: 'Bash', input: { command: 'rm x' }, useId: null },
      },
    ],
    [
      { hook_event_name: 'PreCompact', trigger: 'manual' },
      { kind: 'compaction', phase: 'before', trigger: 'manual' },
    ],
    [
      { hook_event_name: 'PostCompact', trigger: 'auto' },
      { kind: 'compaction', phase: 'after', trigger: 'auto' },
    ],
    [
      { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' },
      { kind: 'stop', lastMessage: 'done' },
    ],
    [
      { hook_event_name: 'Interrupt', turn_id: 't1' },
      { kind: 'other', native: 'Interrupt' },
    ],
    [{ hook_event_name: 'PreToolUse' }, { kind: 'other' }],
  ])('reads %j', (payload, expected) => {
    expect(normalized(payload)).toMatchObject({ ...common, ...expected });
  });

  it("keeps the parent's session id for a subagent and names the subagent", () => {
    expect(
      normalized({ hook_event_name: 'SubagentStart', agent_id: 'sub1', agent_type: 'worker' }),
    ).toStrictEqual({
      ...common,
      native: 'SubagentStart',
      subagentId: 'sub1',
      kind: 'subagent-start',
      subagent: { id: 'sub1', type: 'worker' },
    });
    expect(
      normalized({
        hook_event_name: 'SubagentStop',
        agent_id: 'sub1',
        agent_type: 'worker',
        agent_transcript_path: '/sub.jsonl',
      }),
    ).toMatchObject({
      sessionId: 'thr',
      kind: 'subagent-stop',
      subagentTranscriptPath: '/sub.jsonl',
    });
  });

  it('refuses a payload with no session id', () => {
    expect(normalizeCodexHook({ payload: { hook_event_name: 'Stop' }, name: null }).ok).toBe(false);
    expect(normalizeCodexHook({ payload: 'x', name: null }).ok).toBe(false);
  });
});

describe('answerCodexHook', () => {
  const start = normalized({ hook_event_name: 'SessionStart', source: 'startup' });
  const pre = normalized({ hook_event_name: 'PreToolUse', ...bash });
  const stop = normalized({ hook_event_name: 'Stop' });
  const ask = normalized({ hook_event_name: 'PermissionRequest', ...bash });

  it('says nothing for an empty answer', () => {
    expect(answerCodexHook(stop, {})).toStrictEqual({});
  });

  it('writes permission decisions the way Codex reads them', () => {
    expect(answerCodexHook(ask, { decision: { behavior: 'allow', ruleId: null } })).toStrictEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(
      answerCodexHook(ask, { decision: { behavior: 'deny', message: 'no', ruleId: null } }),
    ).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'no' },
      },
    });
  });

  it('denies a tool call with the reason and keeps any context', () => {
    expect(
      answerCodexHook(pre, { block: 'someone else is editing it', context: 'c' }),
    ).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'someone else is editing it',
        additionalContext: 'c',
      },
    });
  });

  it('adds context only to events that take it, and a notice to any', () => {
    expect(answerCodexHook(start, { context: 'notes', notice: 'seen' })).toStrictEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'notes' },
      systemMessage: 'seen',
    });
    expect(answerCodexHook(stop, { context: 'notes', notice: 'seen' })).toStrictEqual({
      systemMessage: 'seen',
    });
  });
});

describe('codexHooks', () => {
  let dir: string;
  let dirs: AgentDirs;
  const file = (): string => path.join(dirs.configDir, 'hooks.json');

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-codex-hooks-'));
    dirs = { home: dir, configDir: dir };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('watches apply_patch edits through the patch text', () => {
    const patch = '*** Begin Patch\n*** Update File: notes.txt\n@@\n-a\n+b\n*** End Patch\n';
    expect(
      editedFiles(codexHooks.editTools, {
        name: 'apply_patch',
        input: { command: patch },
        useId: 'c',
      }),
    ).toStrictEqual(['notes.txt']);
  });

  it("adds its hooks next to the user's own, with Codex's timeouts, and takes only its own out", async () => {
    const mine = {
      description: 'my hooks',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'python3 ~/stop.py', timeout: 30 }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 's', tool: 't' }] }],
      },
    };
    await writeFile(file(), JSON.stringify(mine));
    const command = 'node "/h/.overlord/bin/overlord-hook.cjs"';
    expect(await codexHooks.installed(dirs)).toBe(false);
    expect(await codexHooks.install(dirs, command)).toStrictEqual({ changed: true });
    expect(await codexHooks.install(dirs, command)).toStrictEqual({ changed: false });
    expect(await codexHooks.installed(dirs)).toBe(true);
    const written: unknown = JSON.parse(await readFile(file(), 'utf8'));
    expect(written).toMatchObject({
      description: 'my hooks',
      hooks: {
        Stop: [
          mine.hooks.Stop[0],
          {
            hooks: [{ type: 'command', command: `${command} --agent codex`, timeout: 5 }],
          },
        ],
        PreToolUse: [mine.hooks.PreToolUse[0], {}],
        SessionEnd: [{ hooks: [{ timeout: 3 }] }],
        PermissionRequest: [{ hooks: [{ timeout: 600 }] }],
      },
    });
    const block = z.object({ hooks: z.record(z.string(), z.unknown()) }).parse(written);
    expect(Object.keys(block.hooks).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
      [...CODEX_HOOK_EVENTS].toSorted((a, b) => a.localeCompare(b)),
    );
    expect(await codexHooks.uninstall(dirs)).toStrictEqual({ changed: true });
    expect(JSON.parse(await readFile(file(), 'utf8'))).toStrictEqual(mine);
  });

  it('keeps its timeouts under what Codex allows', () => {
    expect(codexHookTimeout('SessionEnd')).toBe(3);
    expect(codexHookTimeout('PermissionRequest')).toBe(600);
    expect(codexHookTimeout('PreToolUse')).toBe(5);
  });

  it('refuses a hooks file that is not JSON instead of writing over it', async () => {
    await writeFile(file(), '{ not json');
    await expect(codexHooks.install(dirs, 'node overlord-hook')).rejects.toThrow();
    expect(await readFile(file(), 'utf8')).toBe('{ not json');
  });
});
