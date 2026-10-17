import { describe, expect, it } from 'vitest';

import type { ApiRequest } from '../../shared/model.js';

import { SessionAccumulator, surfaceFor, totalCost } from './accumulator.js';
import type { PriceTable } from './pricing.js';
import type { TranscriptRecord } from './schemas.js';
import { parseTranscriptLine } from './schemas.js';
import {
  assistant,
  attachment,
  iso,
  SESSION,
  sidechain,
  T0,
  text,
  toolResult,
  toolUse,
  usage,
  userPrompt,
} from './test-helpers/fixtures.js';

const PRICES: PriceTable = {
  'claude-opus-5-5': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
};
const MINUTE = 60_000;

function record(fields: unknown): TranscriptRecord {
  const parsed = parseTranscriptLine(JSON.stringify(fields));
  if (parsed === null) {
    throw new Error('fixture did not parse');
  }
  return parsed;
}

function make(): SessionAccumulator {
  return new SessionAccumulator({
    sessionId: SESSION,
    transcriptPath: '/p/sess.jsonl',
    prices: PRICES,
    runningWindowMs: MINUTE,
  });
}

function ingestAll(
  accumulator: SessionAccumulator,
  agentId: string,
  records: readonly unknown[],
): void {
  for (const fields of records) {
    accumulator.ingest(record(fields), agentId);
  }
}

/** The record Claude Code writes when it recaps a session for a returning user. */
function recap(offsetMs: number, content: string): unknown {
  return { type: 'system', subtype: 'away_summary', content, timestamp: iso(offsetMs) };
}

function request(costUsd: number | null): ApiRequest {
  return {
    messageId: 'm',
    requestId: null,
    sessionId: 's',
    agentId: 'a',
    model: 'x',
    timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 },
    ttftMs: null,
    durationMs: null,
    costUsd,
  };
}

const NOTE = (id: string, status: string): string =>
  `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>`;

/**
 * Main thread spawns a foreground agent (toolu_fg) and a background one
 * (toolu_bg). The background agent spawns a nested agent (toolu_nested).
 */
function buildFamily(): SessionAccumulator {
  const accumulator = make();
  ingestAll(accumulator, SESSION, [
    userPrompt('u1', 0, 'Investigate the bug'),
    assistant({
      uuid: 'a1',
      at: 1000,
      messageId: 'm1',
      stop: 'tool_use',
      usage: usage({ input: 100, output: 10 }),
      content: [
        toolUse('toolu_fg', 'Agent', { subagent_type: 'Explore', description: 'look' }),
        toolUse('toolu_bg', 'Agent', { subagent_type: 'general-purpose', run_in_background: true }),
      ],
    }),
    toolResult('u2', 2000, [{ toolUseId: 'toolu_bg', text: 'Async agent launched' }], {
      toolUseResult: { status: 'async_launched' },
    }),
  ]);
  accumulator.addSubagent(
    'fg',
    {
      agentType: 'Explore',
      description: 'look',
      toolUseId: 'toolu_fg',
      spawnDepth: 1,
      requestShape: 'foreground',
    },
    '/p/sess/subagents/agent-fg.jsonl',
  );
  ingestAll(accumulator, 'fg', [
    sidechain('fg', userPrompt('f1', 1100, 'look')),
    sidechain(
      'fg',
      assistant({
        uuid: 'f2',
        at: 1200,
        messageId: 'mf',
        usage: usage({ input: 7 }),
        content: [text('found it')],
      }),
    ),
  ]);
  accumulator.addSubagent(
    'bg',
    {
      agentType: 'general-purpose',
      description: 'bg work',
      toolUseId: 'toolu_bg',
      spawnDepth: 1,
      requestShape: 'background',
    },
    '/p/sess/subagents/agent-bg.jsonl',
  );
  ingestAll(accumulator, 'bg', [
    sidechain('bg', { ...userPrompt('b1', 1500, 'work'), cwd: '/elsewhere', gitBranch: 'wt' }),
    sidechain(
      'bg',
      assistant({
        uuid: 'b2',
        at: 1600,
        messageId: 'mb',
        stop: 'tool_use',
        usage: usage({ output: 3 }),
        content: [toolUse('toolu_nested', 'Agent', { subagent_type: 'fork' })],
      }),
    ),
  ]);
  accumulator.addSubagent(
    'nested',
    {
      agentType: 'fork',
      description: 'nested',
      toolUseId: 'toolu_nested',
      spawnDepth: 2,
      requestShape: 'background',
    },
    null,
  );
  ingestAll(accumulator, 'nested', [sidechain('nested', userPrompt('n1', 1700, 'go'))]);
  return accumulator;
}

describe('SessionAccumulator', () => {
  it('starts with an empty summary and only the main agent', () => {
    const accumulator = new SessionAccumulator({ sessionId: 'empty' });
    expect(accumulator.summary(T0)).toStrictEqual({
      id: 'empty',
      agent: 'claude-code',
      surface: 'cli',
      title: '',
      cwd: '',
      state: 'unknown',
      startedAt: 0,
      updatedAt: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 },
      costUsd: 0,
      model: null,
      effort: null,
      permissionMode: null,
      pid: null,
      transcriptPath: null,
      gitBranch: null,
      version: null,
      agentCount: 0,
      contextFill: null,
      recap: null,
      lastPrompt: null,
      lastPromptAt: null,
    });
    expect(accumulator.agentIds()).toStrictEqual(['empty']);
    expect(accumulator.agents(T0)).toStrictEqual([
      {
        id: 'empty',
        sessionId: 'empty',
        parentAgentId: null,
        parentToolUseId: null,
        agentType: 'main',
        description: '',
        spawnDepth: 0,
        background: false,
        state: 'unknown',
        startedAt: 0,
        endedAt: null,
        transcriptPath: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 },
        toolCallCount: 0,
        currentTool: null,
        model: null,
      },
    ]);
  });

  it('summarizes the session from main thread fields and all usage', () => {
    const accumulator = buildFamily();
    const summary = accumulator.summary(T0 + 1800);
    expect(summary).toStrictEqual({
      id: SESSION,
      agent: 'claude-code',
      surface: 'cli',
      title: 'Investigate the bug',
      cwd: '/work/demo',
      state: 'running',
      startedAt: T0,
      updatedAt: T0 + 2000,
      usage: { input: 107, output: 13, cacheRead: 0, cacheCreation: 0, thinking: 0 },
      costUsd: 120 / 1_000_000,
      model: 'claude-opus-5-5',
      effort: 'high',
      permissionMode: null,
      pid: null,
      transcriptPath: '/p/sess.jsonl',
      gitBranch: 'main',
      version: '2.1.301',
      agentCount: 3,
      // The latest main thread request read 100 tokens of a 1M window.
      contextFill: 100 / 1_000_000,
      recap: null,
      lastPrompt: null,
      lastPromptAt: T0,
    });
  });

  it('links subagents to the thread that spawned them and tracks how they end', () => {
    const accumulator = buildFamily();
    const now = T0 + 2000;
    const byId = new Map(accumulator.agents(now).map((agent) => [agent.id, agent]));
    expect([...byId.keys()]).toStrictEqual([SESSION, 'fg', 'bg', 'nested']);
    expect(byId.get(SESSION)).toMatchObject({
      parentAgentId: null,
      agentType: 'main',
      description: 'Investigate the bug',
      state: 'running',
      startedAt: T0,
      toolCallCount: 2,
      currentTool: 'Agent',
      usage: { input: 100, output: 10 },
      transcriptPath: '/p/sess.jsonl',
      model: 'claude-opus-5-5',
    });
    expect(byId.get('fg')).toMatchObject({
      parentAgentId: SESSION,
      parentToolUseId: 'toolu_fg',
      agentType: 'Explore',
      background: false,
      state: 'idle',
      startedAt: T0 + 1100,
      endedAt: null,
      usage: { input: 7 },
      transcriptPath: '/p/sess/subagents/agent-fg.jsonl',
    });
    expect(byId.get('bg')).toMatchObject({
      parentAgentId: SESSION,
      background: true,
      state: 'running',
      endedAt: null,
      toolCallCount: 1,
      currentTool: 'Agent',
    });
    expect(byId.get('nested')).toMatchObject({
      parentAgentId: 'bg',
      parentToolUseId: 'toolu_nested',
      spawnDepth: 2,
      state: 'running',
      transcriptPath: null,
    });

    ingestAll(accumulator, SESSION, [
      toolResult('u3', 3000, [{ toolUseId: 'toolu_fg', text: 'report' }]),
    ]);
    ingestAll(accumulator, 'bg', [
      sidechain('bg', userPrompt('b3', 3100, NOTE('toolu_nested', 'failed'))),
    ]);
    const later = new Map(accumulator.agents(T0 + 3200).map((agent) => [agent.id, agent]));
    expect(later.get('fg')).toMatchObject({ state: 'done', endedAt: T0 + 3000, currentTool: null });
    expect(later.get('nested')).toMatchObject({ state: 'failed', endedAt: T0 + 3100 });
    expect(later.get('bg')?.state).toBe('running');

    ingestAll(accumulator, SESSION, [
      attachment('q1', 4000, { type: 'queued_command', prompt: NOTE('toolu_bg', 'completed') }),
    ]);
    expect(accumulator.agents(T0 + 4000).find((agent) => agent.id === 'bg')).toMatchObject({
      state: 'done',
      endedAt: T0 + 4000,
    });
  });

  it('is running while any subagent runs and idle once all settle', () => {
    const accumulator = buildFamily();
    expect(accumulator.summary(T0 + 2000 + MINUTE).state).toBe('running');
    expect(accumulator.summary(T0 + 2001 + MINUTE).state).toBe('unfinished');
  });

  it('creates a thread for records from an unregistered subagent and fills meta later', () => {
    const accumulator = make();
    const result = accumulator.ingest(record(sidechain('late', userPrompt('l1', 5, 'hi'))), 'late');
    expect(result.agentId).toBe('late');
    expect(result.feed).toHaveLength(1);
    expect(accumulator.hasSubagentMeta('late')).toBe(false);
    expect(accumulator.hasSubagentMeta('never')).toBe(false);
    expect(accumulator.agents(T0).map((agent) => [agent.id, agent.agentType])).toStrictEqual([
      [SESSION, 'main'],
      ['late', 'unknown'],
    ]);
    accumulator.addSubagent('late', { agentType: 'Plan', description: 'd', spawnDepth: 1 }, '/x');
    expect(accumulator.hasSubagentMeta('late')).toBe(true);
    expect(accumulator.agents(T0)[1]).toMatchObject({ agentType: 'Plan', transcriptPath: '/x' });
    expect(accumulator.summary(T0).agentCount).toBe(1);
    expect(accumulator.summary(T0).cwd).toBe('');
  });

  it('filters tool calls, requests, feed and compactions by agent', () => {
    const accumulator = buildFamily();
    expect(accumulator.toolCalls().map((tool) => tool.id)).toStrictEqual([
      'toolu_fg',
      'toolu_bg',
      'toolu_nested',
    ]);
    expect(accumulator.toolCalls('bg').map((tool) => tool.id)).toStrictEqual(['toolu_nested']);
    expect(accumulator.toolCalls('ghost')).toStrictEqual([]);
    expect(accumulator.requests().map((item) => item.messageId)).toStrictEqual(['m1', 'mf', 'mb']);
    expect(accumulator.requests('fg').map((item) => item.agentId)).toStrictEqual(['fg']);
    expect(accumulator.requests('ghost')).toStrictEqual([]);
    expect(accumulator.feed('fg').map((item) => item.kind)).toStrictEqual(['user', 'text']);
    expect(accumulator.feed('fg', 1).map((item) => item.kind)).toStrictEqual(['text']);
    expect(accumulator.feed('ghost')).toStrictEqual([]);
    expect(accumulator.compactions()).toStrictEqual([]);
    expect(accumulator.compactions('ghost')).toStrictEqual([]);
    ingestAll(accumulator, 'fg', [
      sidechain('fg', {
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: new Date(T0 + 9).toISOString(),
      }),
    ]);
    expect(accumulator.compactions('fg')).toStrictEqual([T0 + 9]);
    expect(accumulator.compactions()).toStrictEqual([]);
  });

  it('keeps the feed limit and preview length it was given', () => {
    const accumulator = new SessionAccumulator({ sessionId: 's', feedLimit: 2, previewChars: 3 });
    ingestAll(accumulator, 's', [
      userPrompt('u1', 0, 'one'),
      userPrompt('u2', 1, 'two'),
      assistant({
        uuid: 'a',
        at: 2,
        messageId: 'm',
        stop: 'tool_use',
        content: [toolUse('t', 'Bash')],
      }),
      toolResult('u3', 3, [{ toolUseId: 't', text: 'abcdef' }]),
    ]);
    expect(accumulator.feed('s').map((item) => item.id)).toStrictEqual(['a:0', 'u3:0']);
    expect(accumulator.toolCalls()[0]?.resultPreview).toBe('abc...');
  });

  it('uses default prices, window and limits', () => {
    const accumulator = new SessionAccumulator({ sessionId: 's' });
    ingestAll(accumulator, 's', [
      userPrompt('u1', 0, 'x'.repeat(500)),
      assistant({
        uuid: 'a',
        at: 1,
        messageId: 'm',
        stop: 'tool_use',
        usage: usage({ input: 1_000_000 }),
        content: [toolUse('t', 'Bash')],
      }),
      toolResult('u2', 2, [{ toolUseId: 't', text: 'y'.repeat(500) }]),
    ]);
    expect(accumulator.requests()[0]?.costUsd).toBe(4);
    expect(accumulator.toolCalls()[0]?.resultPreview).toBe(`${'y'.repeat(400)}...`);
    expect(accumulator.summary(T0 + 2 + 5 * MINUTE).state).toBe('running');
    expect(accumulator.summary(T0 + 3 + 5 * MINUTE).state).toBe('unfinished');
    for (let index = 0; index < 2100; index += 1) {
      accumulator.ingest(record(userPrompt(`p${String(index)}`, 10, 'p')));
    }
    expect(accumulator.feed('s')).toHaveLength(2000);
    expect(accumulator.feed('s', 5)).toHaveLength(5);
  });

  it('picks the title from custom, AI, first prompt and last prompt in that order', () => {
    const accumulator = make();
    expect(accumulator.summary(T0).title).toBe('');
    accumulator.ingest(record({ type: 'last-prompt', lastPrompt: 'last one' }));
    expect(accumulator.summary(T0).title).toBe('last one');
    accumulator.ingest(record({ type: 'last-prompt', leafUuid: 'x' }));
    expect(accumulator.summary(T0).title).toBe('last one');
    accumulator.ingest(record(userPrompt('u1', 0, `  first\n\n  prompt ${'z'.repeat(100)}`)));
    expect(accumulator.summary(T0).title).toBe(`first prompt ${'z'.repeat(67)}...`);
    accumulator.ingest(record({ type: 'ai-title', aiTitle: 'AI title' }));
    expect(accumulator.summary(T0).title).toBe('AI title');
    accumulator.ingest(record({ type: 'custom-title', customTitle: 'Mine' }));
    expect(accumulator.summary(T0).title).toBe('Mine');
    expect(accumulator.agents(T0)[0]?.description).toBe('Mine');
  });

  it('drops terminal escapes from a title taken from a prompt', () => {
    const accumulator = make();
    accumulator.ingest(record(userPrompt('u1', 0, '\u001B[1mFix\u001B[22m the build')));
    expect(accumulator.summary(T0).title).toBe('Fix the build');
  });

  it("keeps Claude Code's newest recap without its /config hint, and the last prompt", () => {
    const accumulator = make();
    expect(accumulator.summary(T0)).toMatchObject({ recap: null, lastPrompt: null });
    accumulator.ingest(record(recap(1000, 'Built the panel. (disable recaps in /config)')));
    accumulator.ingest(record(recap(5000, 'Landed it.\n\nneeds input: remove the worktree?')));
    accumulator.ingest(record(recap(6000, ' (disable recaps in /config)')));
    // A recap with no text or no usable time is skipped.
    accumulator.ingest(record({ type: 'system', subtype: 'away_summary', timestamp: iso(7000) }));
    accumulator.ingest(
      record({ type: 'system', subtype: 'away_summary', content: 'Late', timestamp: 'never' }),
    );
    accumulator.ingest(record({ type: 'last-prompt', lastPrompt: 'Add a summary' }));
    expect(accumulator.summary(T0)).toMatchObject({
      recap: { text: 'Landed it.\n\nneeds input: remove the worktree?', at: T0 + 5000 },
      lastPrompt: 'Add a summary',
    });
    accumulator.ingest(record(recap(9000, 'Sub work.')), 'sub');
    expect(accumulator.summary(T0).recap?.at).toBe(T0 + 5000);
  });

  it('ignores marker records from subagent threads', () => {
    const accumulator = make();
    accumulator.ingest(record({ type: 'ai-title', aiTitle: 'sub' }), 'sub');
    accumulator.ingest(record({ type: 'permission-mode', permissionMode: 'plan' }), 'sub');
    expect(accumulator.summary(T0).title).toBe('');
    expect(accumulator.summary(T0).permissionMode).toBeNull();
  });

  it('tracks the permission mode from mode records and prompts', () => {
    const accumulator = make();
    accumulator.ingest(record({ type: 'permission-mode', permissionMode: 'plan' }));
    expect(accumulator.summary(T0).permissionMode).toBe('plan');
    accumulator.ingest(record({ type: 'permission-mode', permissionMode: 'warp-speed' }));
    expect(accumulator.summary(T0).permissionMode).toBe('plan');
    accumulator.ingest(record(userPrompt('u1', 0, 'x', { permissionMode: 'acceptEdits' })));
    expect(accumulator.summary(T0).permissionMode).toBe('acceptEdits');
    accumulator.ingest(record(userPrompt('u2', 1, 'y', { permissionMode: 'bogus' })));
    expect(accumulator.summary(T0).permissionMode).toBe('acceptEdits');
    accumulator.ingest(record(userPrompt('u3', 1, 'y')));
    expect(accumulator.summary(T0).permissionMode).toBe('acceptEdits');
  });

  it('keeps the first cwd and the latest branch, version and entrypoint', () => {
    const accumulator = make();
    accumulator.ingest(record({ type: 'user', message: { content: 'no cwd yet' } }));
    expect(accumulator.summary(T0).cwd).toBe('');
    accumulator.ingest(record(userPrompt('u1', 0, 'x')));
    accumulator.ingest(
      record({
        ...userPrompt('u2', 1, 'y'),
        cwd: '/moved',
        gitBranch: 'feature',
        version: '2.1.999',
        entrypoint: 'sdk-cli',
      }),
    );
    accumulator.ingest(record({ type: 'user', message: { content: 'z' } }));
    const summary = accumulator.summary(T0);
    expect(summary.cwd).toBe('/work/demo');
    expect(summary.gitBranch).toBe('feature');
    expect(summary.version).toBe('2.1.999');
    expect(summary.surface).toBe('sdk');
  });

  it('falls back to the model attachment when no assistant has answered yet', () => {
    const accumulator = make();
    accumulator.ingest(
      record(attachment('m', 0, { type: 'model', identity: { modelId: 'claude-haiku-5-5' } })),
    );
    expect(accumulator.summary(T0).model).toBe('claude-haiku-5-5');
  });

  it('reports observed context per agent and an empty snapshot for unknown agents', () => {
    const accumulator = buildFamily();
    accumulator.ingest(
      record(attachment('c1', 50, { type: 'prompt_snapshot', systemPrompt: ['main prompt'] })),
    );
    accumulator.ingest(
      record(
        sidechain(
          'fg',
          attachment('c2', 60, { type: 'agent_listing_delta', addedTypes: ['Plan'] }),
        ),
      ),
      'fg',
    );
    const main = accumulator.observedContext();
    expect(main).toMatchObject({
      sessionId: SESSION,
      agentId: SESSION,
      systemPrompt: ['main prompt'],
      at: T0 + 50,
    });
    expect(main.model).toBe('claude-opus-5-5');
    expect(accumulator.observedContext('fg')).toMatchObject({
      agentId: 'fg',
      systemPrompt: null,
      agentTypes: ['Plan'],
      model: 'claude-opus-5-5',
    });
    expect(accumulator.observedContext('ghost')).toMatchObject({
      agentId: 'ghost',
      at: 0,
      model: null,
      loaded: [],
    });
    expect(accumulator.agentIds()).not.toContain('ghost');
  });

  it('falls back to the main thread when no thread holds the spawning tool use', () => {
    const accumulator = make();
    accumulator.addSubagent(
      'orphan',
      { agentType: 'Explore', description: '', spawnDepth: 1, toolUseId: 'toolu_gone' },
      null,
    );
    expect(accumulator.agents(T0)[1]).toMatchObject({
      id: 'orphan',
      parentAgentId: SESSION,
      parentToolUseId: 'toolu_gone',
    });
  });

  it('takes the earliest start across threads', () => {
    const accumulator = make();
    accumulator.ingest(record(userPrompt('u1', 500, 'x')));
    accumulator.ingest(record(sidechain('s', userPrompt('s1', 100, 'y'))), 's');
    accumulator.ingest(record(sidechain('t', userPrompt('t1', 300, 'y'))), 't');
    expect(accumulator.summary(T0 + 500).startedAt).toBe(T0 + 100);
    expect(accumulator.summary(T0 + 500).updatedAt).toBe(T0 + 500);
  });
});

describe('surfaceFor', () => {
  it('maps entrypoints to surfaces', () => {
    expect(surfaceFor(null)).toBe('cli');
    expect(surfaceFor('cli')).toBe('cli');
    expect(surfaceFor('sdk-cli')).toBe('sdk');
    expect(surfaceFor('sdk-ts')).toBe('sdk');
    expect(surfaceFor('sdk-py')).toBe('sdk');
    expect(surfaceFor('claude-desktop')).toBe('desktop-code');
    expect(surfaceFor('something-new')).toBe('cli');
    expect(surfaceFor('constructor')).toBe('cli');
  });
});

describe('totalCost', () => {
  it('sums priced requests and is null only when none can be priced', () => {
    expect(totalCost([])).toBe(0);
    expect(totalCost([request(null)])).toBeNull();
    expect(totalCost([request(null), request(1.5), request(2)])).toBe(3.5);
    expect(totalCost([request(0)])).toBe(0);
  });
});
