import type { PermissionOption, SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { blockText, configValue, inputRecord, resultText } from './content.js';
import { permissionAnswer, permissionChoices } from './permissions.js';
import { AcpTranslator } from './translate.js';
import { tokenUsage, UsageCounter } from './usage.js';

function translator(): AcpTranslator {
  let next = 0;
  return new AcpTranslator({
    newId: (): string => {
      next += 1;
      return `m${String(next)}`;
    },
    modeName: (modeId): string => (modeId === 'urn:agent' ? 'agent' : modeId),
    model: 'gpt-5-mini',
    modeId: 'urn:agent',
    configOptions: [],
  });
}

function text(value: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } };
}

const OPTIONS: PermissionOption[] = [
  { optionId: 'a1', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'a2', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'r1', kind: 'reject_once', name: 'Deny' },
];

describe('blockText and resultText', () => {
  it('shows every kind of content block as text', () => {
    expect(blockText({ type: 'text', text: 'hi' })).toBe('hi');
    expect(blockText({ type: 'resource_link', name: 'a', uri: 'file:///a' })).toBe('file:///a');
    expect(blockText({ type: 'resource', resource: { uri: 'file:///b', text: 'body' } })).toBe(
      'body',
    );
    expect(blockText({ type: 'resource', resource: { uri: 'file:///c', blob: 'AA==' } })).toBe(
      'file:///c',
    );
    expect(blockText({ type: 'image', data: '', mimeType: 'image/png' })).toBe('[image]');
  });

  it('reads a result from content, then a message, then the raw output', () => {
    expect(
      resultText({
        toolCallId: 't',
        content: [
          { type: 'content', content: { type: 'text', text: 'one' } },
          { type: 'diff', path: '/a.py', newText: 'x' },
          { type: 'terminal', terminalId: 'term-1' },
        ],
      }),
    ).toBe('one\nEdited /a.py\nTerminal term-1');
    expect(resultText({ toolCallId: 't', rawOutput: { message: 'no', code: 'rejected' } })).toBe(
      'no',
    );
    expect(resultText({ toolCallId: 't', rawOutput: 'plain' })).toBe('plain');
    expect(resultText({ toolCallId: 't', rawOutput: { exit: 0 } })).toBe('{"exit":0}');
    expect(resultText({ toolCallId: 't' })).toBe('');
  });

  it('turns any input into a record', () => {
    expect(inputRecord({ a: 1 })).toStrictEqual({ a: 1 });
    expect(inputRecord('ls')).toStrictEqual({ value: 'ls' });
    expect(inputRecord(null)).toStrictEqual({});
  });
});

describe('usage', () => {
  it('counts cached tokens apart from input', () => {
    expect(
      tokenUsage({
        inputTokens: 10_605,
        outputTokens: 685,
        totalTokens: 11_290,
        thoughtTokens: 576,
        cachedReadTokens: 1152,
        cachedWriteTokens: 0,
      }),
    ).toStrictEqual({ input: 9453, output: 685, cacheRead: 1152, cacheCreation: 0, thinking: 576 });
  });

  it('takes each turn as the change in a running total', () => {
    const counter = new UsageCounter('cumulative', false);
    const first = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
    expect(counter.turn(first, false)).toMatchObject({ input: 100, output: 10 });
    // A cancel that made no model call repeats the total.
    expect(counter.turn(first, true)).toBeNull();
    expect(
      counter.turn({ inputTokens: 160, outputTokens: 15, totalTokens: 175 }, false),
    ).toMatchObject({ input: 60, output: 5 });
    // A total that went down starts over.
    expect(
      counter.turn({ inputTokens: 20, outputTokens: 2, totalTokens: 22 }, false),
    ).toMatchObject({ input: 20, output: 2 });
    expect(counter.turn(null, false)).toBeNull();
  });

  it('only sets the baseline from the first total of a resumed session', () => {
    const counter = new UsageCounter('cumulative', true);
    expect(
      counter.turn({ inputTokens: 900, outputTokens: 90, totalTokens: 990 }, false),
    ).toBeNull();
    expect(
      counter.turn({ inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }, false),
    ).toMatchObject({ input: 100, output: 10 });
  });

  it('takes per turn reports as they are and skips a cancelled one', () => {
    const counter = new UsageCounter('per_turn', true);
    const usage = { inputTokens: 50, outputTokens: 5, totalTokens: 55 };
    expect(counter.turn(usage, false)).toMatchObject({ input: 50 });
    expect(counter.turn(usage, true)).toBeNull();
  });
});

describe('permissions', () => {
  it('offers what the options allow', () => {
    expect(permissionChoices(OPTIONS)).toStrictEqual(['allow', 'allow_session', 'deny', 'cancel']);
    expect(permissionChoices([{ optionId: 'r', kind: 'reject_once', name: 'No' }])).toStrictEqual([
      'deny',
      'cancel',
    ]);
  });

  it('picks the option for each decision, or the nearest one', () => {
    const allow = { behavior: 'allow', updatedInput: {} } as const;
    expect(permissionAnswer(allow, OPTIONS).outcome).toStrictEqual({
      outcome: 'selected',
      optionId: 'a1',
    });
    expect(permissionAnswer({ ...allow, scope: 'session' }, OPTIONS).outcome).toStrictEqual({
      outcome: 'selected',
      optionId: 'a2',
    });
    expect(
      permissionAnswer({ ...allow, scope: 'session' }, [
        { optionId: 'a1', kind: 'allow_once', name: 'Allow once' },
      ]).outcome,
    ).toStrictEqual({ outcome: 'selected', optionId: 'a1' });
    expect(permissionAnswer({ behavior: 'deny', message: 'no' }, OPTIONS)).toStrictEqual({
      outcome: { outcome: 'selected', optionId: 'r1' },
      cancelTurn: false,
    });
    expect(permissionAnswer({ behavior: 'deny', message: 'no' }, [])).toStrictEqual({
      outcome: { outcome: 'cancelled' },
      cancelTurn: false,
    });
    expect(
      permissionAnswer({ behavior: 'deny', message: 'no', interrupt: true }, OPTIONS),
    ).toStrictEqual({ outcome: { outcome: 'cancelled' }, cancelTurn: true });
  });
});

describe('AcpTranslator', () => {
  it('joins chunks into one message when a tool starts', () => {
    const acp = translator();
    expect(
      acp.update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Hmm' },
      }),
    ).toStrictEqual([]);
    acp.update(text('Work'));
    acp.update(text('ing'));
    const events = acp.update({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'List files',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'ls' },
    });
    expect(events).toStrictEqual([
      {
        type: 'message',
        messageId: 'm1',
        requestId: null,
        model: 'gpt-5-mini',
        agentId: null,
        parentToolUseId: null,
        usage: null,
        blocks: [
          { type: 'thinking', text: 'Hmm' },
          { type: 'text', text: 'Working' },
          { type: 'tool_use', id: 't1', name: 'execute', input: { command: 'ls' } },
        ],
      },
    ]);
    expect(
      acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
    ).toStrictEqual([{ type: 'tool_result', toolUseId: 't1', ok: true, text: '' }]);
  });

  it('holds a call until its input arrives', () => {
    const acp = translator();
    expect(
      acp.update({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read a.py',
        kind: 'read',
      }),
    ).toStrictEqual([]);
    expect(
      acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }),
    ).toStrictEqual([]);
    expect(
      acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', rawInput: { path: 'a' } }),
    ).toMatchObject([
      {
        type: 'message',
        blocks: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } }],
      },
    ]);
  });

  it('sends a held call with its title when it finishes with no input', () => {
    const acp = translator();
    acp.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Search' });
    expect(
      acp.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'failed',
        rawOutput: { message: 'boom' },
      }),
    ).toMatchObject([
      {
        type: 'message',
        blocks: [{ type: 'tool_use', name: 'Search', input: { title: 'Search' } }],
      },
      { type: 'tool_result', toolUseId: 't1', ok: false, text: 'boom' },
    ]);
  });

  it('shows a call first seen when done as a message and a result', () => {
    const acp = translator();
    expect(
      acp.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't9',
        title: 'Fetch',
        kind: 'fetch',
        status: 'completed',
        rawOutput: 'ok',
      }),
    ).toMatchObject([
      {
        type: 'message',
        blocks: [{ type: 'tool_use', id: 't9', name: 'fetch', input: { title: 'Fetch' } }],
      },
      { type: 'tool_result', toolUseId: 't9', ok: true, text: 'ok' },
    ]);
    expect(
      acp.update({
        sessionUpdate: 'tool_call',
        toolCallId: 't8',
        title: 'Done already',
        status: 'completed',
      }),
    ).toMatchObject([
      { type: 'message', blocks: [{ type: 'tool_use', id: 't8' }] },
      { type: 'tool_result', toolUseId: 't8', ok: true },
    ]);
  });

  it('releases a held call when the permission request names its input', () => {
    const acp = translator();
    acp.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit', kind: 'edit' });
    const call = { toolCallId: 't1', title: 'Edit' };
    expect(acp.nameOf(call)).toBe('edit');
    expect(acp.permissionAsked(call)).toStrictEqual([]);
    expect(acp.permissionAsked({ ...call, rawInput: { path: 'a' } })).toMatchObject([
      { type: 'message', blocks: [{ type: 'tool_use', name: 'edit', input: { path: 'a' } }] },
    ]);
    expect(acp.permissionAsked({ ...call, rawInput: { path: 'a' } })).toStrictEqual([]);
    expect(acp.nameOf({ toolCallId: 'other' })).toBe('tool');
  });

  it('ends a turn with the last text, usage on the last message and the stop reason', () => {
    const acp = translator();
    acp.update(text('All done.'));
    // Holding a call sends the text before it.
    expect(
      acp.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Wait' }),
    ).toMatchObject([
      { type: 'message', messageId: 'm1', blocks: [{ type: 'text', text: 'All done.' }] },
    ]);
    const usage = { input: 1, output: 2, cacheRead: 0, cacheCreation: 0, thinking: 0 };
    expect(acp.endTurn({ stopReason: 'end_turn', usage, durationMs: 5 })).toMatchObject([
      {
        type: 'message',
        messageId: 'm2',
        blocks: [{ type: 'tool_use', input: { title: 'Wait' } }],
      },
      { type: 'usage', messageId: 'm2', usage, durationMs: 5 },
      { type: 'turn_result', ok: true, subtype: 'end_turn', text: 'All done.', usage },
    ]);
    expect(acp.endTurn({ stopReason: 'cancelled', usage: null, durationMs: 1 })).toStrictEqual([
      {
        type: 'turn_result',
        ok: false,
        subtype: 'interrupted',
        text: null,
        costUsd: null,
        turns: null,
        durationMs: 1,
        usage: null,
      },
    ]);
    expect(acp.failTurn('auth required', 2)).toMatchObject([
      { type: 'turn_result', ok: false, subtype: 'error', text: 'auth required' },
    ]);
  });

  it('mints an id for usage when the turn wrote no message', () => {
    const acp = translator();
    const usage = { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 };
    expect(acp.endTurn({ stopReason: 'max_tokens', usage, durationMs: 0 })).toMatchObject([
      { type: 'usage', messageId: 'm1' },
      { type: 'turn_result', ok: false, subtype: 'max_tokens' },
    ]);
  });

  it('reports context, cost, plans, notices, compaction and mode or model changes', () => {
    const acp = translator();
    expect(
      acp.update({
        sessionUpdate: 'usage_update',
        used: 10,
        size: 100,
        cost: { amount: 0.5, currency: 'USD' },
      }),
    ).toStrictEqual([{ type: 'context', usedTokens: 10, maxTokens: 100 }]);
    acp.update({
      sessionUpdate: 'usage_update',
      used: 12,
      size: 100,
      cost: { amount: 9, currency: 'EUR' },
    });
    expect(acp.window).toStrictEqual({ used: 12, size: 100 });
    expect(acp.endTurn({ stopReason: 'end_turn', usage: null, durationMs: 0 })).toMatchObject([
      { type: 'turn_result', costUsd: 0.5 },
    ]);
    expect(
      acp.update({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read', priority: 'high', status: 'completed' },
          { content: 'Fix', priority: 'low', status: 'pending' },
          { content: 'Test', priority: 'low', status: 'in_progress' },
        ],
      }),
    ).toStrictEqual([{ type: 'notice', text: 'Plan:\n- [x] Read\n- [ ] Fix\n- [~] Test' }]);
    expect(
      acp.update({
        sessionUpdate: 'notice',
        severity: 'warning',
        title: 'Slow',
        description: 'Busy',
      }),
    ).toStrictEqual([{ type: 'notice', text: 'Slow: Busy' }]);
    expect(acp.update({ sessionUpdate: 'notice', severity: 'info', title: 'Hi' })).toStrictEqual([
      { type: 'notice', text: 'Hi' },
    ]);
    expect(
      acp.update({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'completed' }),
    ).toStrictEqual([{ type: 'compacted', trigger: 'auto', preTokens: null }]);
    expect(
      acp.update({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'in_progress' }),
    ).toStrictEqual([]);
    expect(
      acp.update({ sessionUpdate: 'current_mode_update', currentModeId: 'urn:agent' }),
    ).toStrictEqual([]);
    expect(
      acp.update({ sessionUpdate: 'current_mode_update', currentModeId: 'urn:plan' }),
    ).toStrictEqual([{ type: 'mode_changed', permissionMode: 'urn:plan' }]);
    expect(
      acp.update({
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            type: 'select',
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: 'gpt-5.4',
            options: [],
          },
          {
            type: 'select',
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            currentValue: 'urn:agent',
            options: [],
          },
        ],
      }),
    ).toStrictEqual([
      { type: 'model_changed', model: 'gpt-5.4' },
      { type: 'mode_changed', permissionMode: 'agent' },
    ]);
    expect(acp.model).toBe('gpt-5.4');
    expect(
      acp.update({ sessionUpdate: 'available_commands_update', availableCommands: [] }),
    ).toStrictEqual([]);
    expect(
      acp.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } }),
    ).toStrictEqual([]);
  });

  it('takes settings the agent sent back without reporting them as changes', () => {
    const acp = translator();
    acp.configChanged([
      {
        type: 'select',
        id: 'm',
        name: 'Model',
        category: 'model',
        currentValue: 'big',
        options: [],
      },
      { type: 'boolean', id: 'b', name: 'Fast', currentValue: true },
    ]);
    expect(acp.model).toBe('big');
    expect(acp.mode).toBe('urn:agent');
    expect(configValue(acp.config, 'model')).toStrictEqual({ id: 'm', value: 'big' });
    expect(configValue(acp.config, 'thought_level')).toBeNull();
    acp.modeSet('urn:plan');
    expect(acp.mode).toBe('urn:plan');
  });
});
