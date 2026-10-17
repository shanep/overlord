// cspell:words execpolicy

import { describe, expect, it } from 'vitest';

import { CodexTranslator, initEvent, rateLimitEvent } from './app-server.js';
import { approvalAsk, approvalReply } from './approvals.js';
import { shellScript } from './items.js';

const TURN = 'turn-1';

function item(type: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { threadId: 't', turnId: TURN, item: { type, id: `${type}-1`, ...fields } };
}

describe('CodexTranslator', () => {
  it('shows a file change as apply_patch and asks about it with its changes', () => {
    const translator = new CodexTranslator('gpt-6-luna');
    const change = item('fileChange', {
      changes: [{ path: 'notes.txt', kind: { type: 'update', move_path: null }, diff: '-a\n+b' }],
      status: 'inProgress',
    });
    expect(translator.notification('item/started', change)).toStrictEqual([
      {
        type: 'message',
        messageId: `${TURN}:1`,
        requestId: null,
        model: 'gpt-6-luna',
        agentId: null,
        parentToolUseId: null,
        usage: null,
        blocks: [
          {
            type: 'tool_use',
            id: 'fileChange-1',
            name: 'apply_patch',
            input: { changes: [{ path: 'notes.txt', kind: 'update', diff: '-a\n+b' }] },
          },
        ],
      },
    ]);
    const ask = approvalAsk(
      'item/fileChange/requestApproval',
      { itemId: 'fileChange-1', reason: 'edit', grantRoot: null },
      translator,
    );
    expect(ask).toStrictEqual({
      toolName: 'apply_patch',
      input: {
        changes: [{ path: 'notes.txt', kind: 'update', diff: '-a\n+b' }],
        reason: 'edit',
      },
      toolUseId: 'fileChange-1',
      choices: ['allow', 'allow_session', 'deny', 'cancel'],
    });
    const done = item('fileChange', {
      changes: [{ path: 'notes.txt', kind: { type: 'update', move_path: null }, diff: '' }],
      status: 'completed',
    });
    expect(translator.notification('item/completed', done)).toStrictEqual([
      { type: 'tool_result', toolUseId: 'fileChange-1', ok: true, text: 'update notes.txt' },
    ]);
  });

  it('shows an MCP call under its server and reasoning as thinking', () => {
    const translator = new CodexTranslator('gpt-6-luna');
    const call = item('mcpToolCall', {
      server: 'docs',
      tool: 'search',
      arguments: { q: 'x' },
      status: 'completed',
      result: { content: [{ type: 'text', text: 'found' }, { type: 'image' }] },
      error: null,
    });
    expect(translator.notification('item/completed', call)).toMatchObject([
      {
        type: 'message',
        blocks: [{ type: 'tool_use', name: 'mcp__docs__search', input: { q: 'x' } }],
      },
      { type: 'tool_result', ok: true, text: 'found\n{"type":"image"}' },
    ]);
    const failed = item('mcpToolCall', {
      id: 'm2',
      server: 'docs',
      tool: 'search',
      arguments: null,
      status: 'failed',
      result: null,
      error: { message: 'offline' },
    });
    expect(translator.notification('item/completed', failed)).toMatchObject([
      { blocks: [{ input: {} }] },
      { type: 'tool_result', toolUseId: 'm2', ok: false, text: 'offline' },
    ]);
    expect(
      translator.notification(
        'item/completed',
        item('reasoning', { summary: ['Plan'], content: ['Look'] }),
      ),
    ).toMatchObject([{ blocks: [{ type: 'thinking', text: 'Plan\nLook' }] }]);
    expect(
      translator.notification('item/completed', item('reasoning', { summary: [], content: [] })),
    ).toStrictEqual([]);
    expect(
      translator.notification('item/completed', item('userMessage', { content: [] })),
    ).toStrictEqual([]);
    expect(translator.notification('item/completed', { nonsense: true })).toStrictEqual([]);
  });

  it('reports warnings, reroutes and compaction', () => {
    const translator = new CodexTranslator('gpt-6-luna');
    expect(translator.notification('warning', { threadId: null, message: 'slow' })).toStrictEqual([
      { type: 'notice', text: 'slow' },
    ]);
    expect(
      translator.notification('configWarning', { summary: 'bad key', details: 'line 3' }),
    ).toStrictEqual([{ type: 'notice', text: 'bad key: line 3' }]);
    expect(
      translator.notification('deprecationNotice', { summary: 'old', details: null }),
    ).toStrictEqual([{ type: 'notice', text: 'old' }]);
    expect(
      translator.notification('error', { error: { message: 'x' }, willRetry: false }),
    ).toStrictEqual([]);
    expect(translator.notification('model/rerouted', { toModel: 'gpt-6-mini' })).toStrictEqual([
      { type: 'model_changed', model: 'gpt-6-mini' },
    ]);
    expect(
      translator.notification('item/completed', item('agentMessage', { text: 'hi' })),
    ).toMatchObject([{ model: 'gpt-6-mini' }]);
    expect(
      translator.notification('thread/compacted', { threadId: 't', turnId: TURN }),
    ).toStrictEqual([{ type: 'compacted', trigger: 'auto', preTokens: null }]);
    expect(translator.notification('item/completed', item('contextCompaction', {}))).toStrictEqual([
      { type: 'compacted', trigger: 'auto', preTokens: null },
    ]);
    expect(translator.notification('model/rerouted', {})).toStrictEqual([]);
    expect(translator.notification('turn/completed', {})).toStrictEqual([]);
    expect(translator.notification('thread/status/changed', {})).toStrictEqual([]);
  });
});

describe('the app-server shapes', () => {
  it('unwraps the shell Codex runs a command in', () => {
    expect(shellScript("/bin/zsh -lc 'touch approved.txt'")).toBe('touch approved.txt');
    expect(shellScript(String.raw`bash -lc 'echo '\''hi'\'''`)).toBe("echo 'hi'");
    expect(shellScript('/bin/zsh -lc ls')).toBe('ls');
    expect(shellScript('git status')).toBe('git status');
  });

  it('leaves the mode out for a policy Overlord has no id for', () => {
    const thread = {
      thread: { id: 't', cliVersion: null },
      model: 'm',
      cwd: '/w',
      approvalPolicy: { granular: {} },
      sandbox: { type: 'readOnly' },
    };
    expect(initEvent(thread, ['untrusted/read-only'])).toMatchObject({
      permissionMode: null,
      version: null,
    });
    expect(initEvent({ ...thread, approvalPolicy: 'untrusted', sandbox: null }, [])).toMatchObject({
      permissionMode: null,
    });
  });

  it('skips a rate limit report with no windows', () => {
    expect(rateLimitEvent({ rateLimits: { primary: null, secondary: null } })).toBeNull();
    expect(rateLimitEvent({})).toBeNull();
  });

  it('asks for and grants permissions for one turn', () => {
    const translator = new CodexTranslator('m');
    const params = {
      itemId: 'p1',
      cwd: '/w',
      reason: 'needs the network',
      permissions: { network: { enabled: true }, fileSystem: null },
    };
    expect(approvalAsk('item/permissions/requestApproval', params, translator)).toStrictEqual({
      toolName: 'request_permissions',
      input: {
        permissions: { network: { enabled: true } },
        cwd: '/w',
        reason: 'needs the network',
      },
      toolUseId: 'p1',
      choices: ['allow', 'allow_session', 'deny'],
    });
    expect(
      approvalReply('item/permissions/requestApproval', params, {
        behavior: 'allow',
        updatedInput: {},
        scope: 'session',
      }),
    ).toStrictEqual({ permissions: { network: { enabled: true } }, scope: 'session' });
    expect(
      approvalReply('item/permissions/requestApproval', params, {
        behavior: 'allow',
        updatedInput: {},
      }),
    ).toStrictEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
    expect(
      approvalReply('item/permissions/requestApproval', params, {
        behavior: 'deny',
        message: 'no',
      }),
    ).toStrictEqual({ permissions: {}, scope: 'turn' });
    expect(approvalAsk('item/permissions/requestApproval', {}, translator)).toBeNull();
    expect(approvalAsk('item/fileChange/requestApproval', {}, translator)).toBeNull();
    expect(approvalAsk('item/commandExecution/requestApproval', {}, translator)).toBeNull();
    expect(approvalAsk('execCommandApproval', {}, translator)).toBeNull();
  });

  it('answers once, for the session, with a decline or by cancelling the turn', () => {
    const method = 'item/commandExecution/requestApproval';
    expect(approvalReply(method, {}, { behavior: 'allow', updatedInput: {} })).toStrictEqual({
      decision: 'accept',
    });
    expect(
      approvalReply(method, {}, { behavior: 'allow', updatedInput: {}, scope: 'session' }),
    ).toStrictEqual({ decision: 'acceptForSession' });
    expect(approvalReply(method, {}, { behavior: 'deny', message: 'no' })).toStrictEqual({
      decision: 'decline',
    });
    expect(
      approvalReply(method, {}, { behavior: 'deny', message: 'stop', interrupt: true }),
    ).toStrictEqual({ decision: 'cancel' });
    const translator = new CodexTranslator('m');
    const ask = (availableDecisions: unknown): unknown =>
      approvalAsk(method, { itemId: 'e', command: 'ls', availableDecisions }, translator);
    expect(ask(['accept', { acceptWithExecpolicyAmendment: {} }, 'cancel'])).toMatchObject({
      choices: ['allow', 'deny', 'cancel'],
    });
    expect(ask(null)).toMatchObject({ choices: ['allow', 'allow_session', 'deny', 'cancel'] });
  });
});
