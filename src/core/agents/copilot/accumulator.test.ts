import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COPILOT } from '../../../shared/agents.js';
import type { FeedItem } from '../../../shared/model.js';
import { makeTemporaryDirectory, removeDir } from '../../transcripts/test-helpers/fixtures.js';

import { CopilotRecords } from './accumulator.js';

// cspell:words Aiu

const STATE_DIR = fileURLToPath(
  new URL('../../../../test/fixtures/copilot/1.0.89/session-state/', import.meta.url),
);

const PLAIN = '11111111-1111-4111-8111-000000000001';
const SHELL = '11111111-1111-4111-8111-000000000002';
const EDIT = '11111111-1111-4111-8111-000000000003';
const DENIED = '11111111-1111-4111-8111-000000000004';
const ACP = '314df6e1-afd1-4b9c-bdf3-7cf94861398e';

const LATER = Date.parse('2026-10-18T00:00:00.000Z');

function fixtureLines(sessionId: string): string[] {
  const text = readFileSync(path.join(STATE_DIR, sessionId, 'events.jsonl'), 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

function load(
  sessionId: string,
  lines: readonly string[] = fixtureLines(sessionId),
): CopilotRecords {
  const records = new CopilotRecords({
    sessionId,
    transcriptPath: `/state/${sessionId}/events.jsonl`,
  });
  for (const line of lines) {
    records.ingest(line, sessionId);
  }
  return records;
}

/** The lines up to and including the first one of this type. */
function linesUntil(sessionId: string, type: string): string[] {
  const lines = fixtureLines(sessionId);
  const index = lines.findIndex((line) => line.includes(`"type":"${type}"`));
  return lines.slice(0, index + 1);
}

function kinds(items: readonly FeedItem[]): string[] {
  return items.map((item) => item.kind);
}

function event(
  type: string,
  at: number,
  data: unknown,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type,
    data,
    id: `${type}-${String(at)}`,
    timestamp: new Date(at).toISOString(),
    parentId: null,
    ...extra,
  });
}

/** One assistant.message line in the shape Copilot writes. */
function message(at: number, messageId: string, extra: Record<string, unknown> = {}): string {
  return event('assistant.message', at, {
    messageId,
    model: 'gpt-5-mini',
    content: 'working',
    toolRequests: [],
    apiCallId: `call-${messageId}`,
    ...extra,
  });
}

describe('CopilotRecords on recorded sessions', () => {
  it('reads a plain answer: title, folder, model, totals and cost', () => {
    const records = load(PLAIN);
    expect(records.summary(LATER)).toMatchObject({
      id: PLAIN,
      agent: COPILOT,
      surface: 'cli',
      title: 'Reply with the word ok',
      cwd: '/work/repo',
      gitBranch: 'master',
      state: 'done',
      model: 'gpt-5-mini',
      version: '1.0.89',
      usage: { input: 12_055, output: 122, cacheRead: 0, cacheCreation: 0, thinking: 64 },
      agentCount: 0,
      lastPrompt: 'Reply with the word ok',
    });
    // 325,775,000 nano AI units at $0.01 per AI credit.
    expect(records.summary(LATER).costUsd).toBeCloseTo(0.00325775, 10);
    expect(records.summary(LATER).contextFill).toBeCloseTo(13_197 / 128_000, 6);
    expect(records.busy()).toBe(false);
    expect(kinds(records.feed(PLAIN))).toStrictEqual(['user', 'text']);
  });

  it('puts the shutdown totals on the calls without counting them twice', () => {
    const records = load(EDIT);
    const requests = records.requests();
    expect(requests.map((request) => request.requestId)).toStrictEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ]);
    expect(requests.every((request) => request.model === 'gpt-5-mini')).toBe(true);
    expect(requests.every((request) => request.agentId === EDIT)).toBe(true);
    // Only the totals carry tokens, so they land on the session's last call.
    expect(requests.at(-1)?.usage).toStrictEqual({
      input: 792,
      output: 654,
      cacheRead: 36_096,
      cacheCreation: 0,
      thinking: 320,
    });
    expect(records.summary(LATER).usage.cacheRead).toBe(36_096);
    expect(records.summary(LATER).costUsd).toBeCloseTo(0.0024084, 10);

    const [shutdown] = fixtureLines(EDIT).slice(-1);
    const again = records.ingest(String(shutdown), EDIT);
    expect(again?.requests).toStrictEqual([]);
    expect(records.summary(LATER).usage.input).toBe(792);
  });

  it('records each tool call with its result', () => {
    const records = load(EDIT);
    const tools = records.toolCalls();
    expect(tools.map((tool) => [tool.name, tool.ok])).toStrictEqual([
      ['view', true],
      ['edit', true],
    ]);
    expect(tools[1]?.input).toMatchObject({ path: '/work/repo/calc.py' });
    expect(tools[1]?.resultPreview).toBe('File /work/repo/calc.py updated with changes.');
    expect(kinds(records.feed(EDIT))).toStrictEqual([
      'user',
      'thinking',
      'text',
      'tool_use',
      'tool_result',
      'thinking',
      'tool_use',
      'tool_result',
      'text',
    ]);
    expect(records.agents(LATER)[0]).toMatchObject({
      id: EDIT,
      toolCallCount: 2,
      currentTool: null,
    });
  });

  it('marks a tool the flags denied as failed', () => {
    const records = load(DENIED);
    const [tool] = records.toolCalls();
    expect(tool).toMatchObject({ name: 'bash', ok: false });
    expect(tool?.resultPreview).toContain('Permission to run this tool was denied');
    const result = records.feed(DENIED).find((item) => item.kind === 'tool_result');
    expect(result).toMatchObject({ ok: false, toolUseId: tool?.id });
  });

  it('runs while a turn is open and waits on a permission prompt', () => {
    const running = load(SHELL, linesUntil(SHELL, 'tool.execution_start'));
    const now = Date.parse('2026-10-17T04:07:40.000Z');
    expect(running.summary(now).state).toBe('running');
    expect(running.busy()).toBe(true);
    expect(running.agents(now)[0]?.currentTool).toBe('bash');
    expect(running.summary(LATER).state).toBe('idle');

    const asking = load(ACP, linesUntil(ACP, 'permission.requested'));
    expect(asking.summary(now).state).toBe('waiting');
    expect(asking.busy()).toBe(true);
  });

  it('finishes a session whose second prompt was cancelled', () => {
    const records = load(ACP);
    expect(records.summary(LATER)).toMatchObject({ state: 'done', version: '0.0.0' });
    expect(records.busy()).toBe(false);
    expect(records.toolCalls()[0]).toMatchObject({
      ok: false,
      resultPreview: 'The user rejected this tool call.',
    });
    expect(records.requests()).toHaveLength(1);
    expect(records.feed(ACP).filter((item) => item.kind === 'user')).toHaveLength(2);
  });

  it('closes a turn that ends without asking for tools', () => {
    const records = load(SHELL, linesUntil(SHELL, 'session.usage_checkpoint'));
    expect(records.busy()).toBe(false);
    expect(records.summary(Date.parse('2026-10-17T04:07:40.000Z')).state).toBe('idle');
    expect(records.summary(LATER).costUsd).toBeCloseTo(0.00204405, 10);
    expect(records.summary(LATER).usage.output).toBe(0);
  });
});

describe('CopilotRecords on events the recordings do not have', () => {
  const ID = 'aaaaaaaa-0000-4000-8000-000000000000';
  const T = Date.parse('2026-10-17T05:00:00.000Z');

  it('takes per call usage and adds only the rest from the shutdown totals', () => {
    const records = new CopilotRecords({ sessionId: ID, transcriptPath: null });
    const usage = {
      model: 'gpt-5-mini',
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      reasoningTokens: 10,
      apiCallId: 'call-m1',
      copilotUsage: { totalNanoAiu: 1_000_000 },
    };
    const lines = [
      event('session.start', T, {
        sessionId: ID,
        copilotVersion: '1.0.95',
        selectedModel: 'gpt-5-mini',
      }),
      event('user.message', T + 1, { content: 'hi', messageId: 'u1' }),
      message(T + 2, 'm1'),
      event('assistant.usage', T + 3, usage, { ephemeral: true }),
      message(T + 4, 'm2'),
      event('session.shutdown', T + 5, {
        shutdownType: 'routine',
        totalNanoAiu: 3_000_000,
        modelMetrics: {
          'gpt-5-mini': {
            usage: {
              inputTokens: 1500,
              outputTokens: 80,
              cacheReadTokens: 1100,
              cacheWriteTokens: 0,
              reasoningTokens: 10,
            },
            totalNanoAiu: 3_000_000,
          },
        },
      }),
    ];
    for (const line of lines) {
      records.ingest(line, ID);
    }
    const [first, second] = records.requests();
    expect(first?.usage).toStrictEqual({
      input: 200,
      output: 50,
      cacheRead: 800,
      cacheCreation: 0,
      thinking: 10,
    });
    expect(second?.usage).toStrictEqual({
      input: 200,
      output: 30,
      cacheRead: 300,
      cacheCreation: 0,
      thinking: 0,
    });
    expect(records.summary(T + 6).usage).toMatchObject({ input: 400, output: 80, cacheRead: 1100 });
    expect(records.summary(T + 6).costUsd).toBeCloseTo(0.00003, 10);
    expect(records.summary(T + 6).version).toBe('1.0.95');
  });

  it('opens a thread per subagent and files its events there', () => {
    const records = new CopilotRecords({ sessionId: ID, transcriptPath: null });
    const lines = [
      event('user.message', T, { content: 'look around', messageId: 'u1' }),
      message(T + 1, 'm1', {
        toolRequests: [{ toolCallId: 'task1', name: 'task', arguments: { prompt: 'explore' } }],
      }),
      event('tool.execution_start', T + 2, {
        toolCallId: 'task1',
        toolName: 'task',
        arguments: {},
      }),
      event('subagent.started', T + 3, {
        toolCallId: 'task1',
        agentName: 'explore',
        agentDisplayName: 'Explore',
        agentDescription: 'Finds code',
      }),
      event(
        'tool.execution_start',
        T + 4,
        { toolCallId: 'grep1', toolName: 'grep', arguments: {}, parentToolCallId: 'task1' },
        { agentId: 'sub-a' },
      ),
      event(
        'assistant.message',
        T + 5,
        { messageId: 'm2', content: 'found it', parentToolCallId: 'task1' },
        { agentId: 'sub-a' },
      ),
    ];
    for (const line of lines) {
      records.ingest(line, ID);
    }
    const now = T + 6;
    const [main, sub] = records.agents(now);
    expect(main).toMatchObject({ id: ID, toolCallCount: 1, currentTool: 'task' });
    expect(sub).toMatchObject({
      id: 'task1',
      parentAgentId: ID,
      parentToolUseId: 'task1',
      agentType: 'explore',
      description: 'Finds code',
      spawnDepth: 1,
      state: 'running',
      currentTool: 'grep',
    });
    expect(records.requests('task1').map((request) => request.messageId)).toStrictEqual(['m2']);
    expect(records.summary(now).agentCount).toBe(1);

    const end = records.ingest(
      event('subagent.completed', T + 7, {
        toolCallId: 'task1',
        agentName: 'explore',
        agentDisplayName: 'Explore',
      }),
      ID,
    );
    expect(end).not.toBeNull();
    expect(records.agents(T + 8)[1]).toMatchObject({ state: 'done', endedAt: T + 7 });
  });

  it('keeps going past unknown events, ephemeral noise and lines that are not events', () => {
    const records = new CopilotRecords({ sessionId: ID, transcriptPath: null });
    expect(records.ingest('not json', ID)).toBeNull();
    expect(records.ingest('"a string"', ID)).toBeNull();
    expect(records.ingest(event('session.something_new', T, {}), ID)).toBeNull();
    expect(
      records.ingest(
        event('assistant.message_delta', T, { deltaContent: 'x' }, { ephemeral: true }),
        ID,
      ),
    ).toBeNull();
    expect(records.ingest(event('assistant.message', T, { content: 'no id' }), ID)).toBeNull();
    expect(
      records.ingest(JSON.stringify({ type: 'user.message', data: {}, timestamp: 'never' }), ID),
    ).toBeNull();
    expect(records.summary(T).state).toBe('idle');
  });

  it('follows the model, mode, title and compactions', () => {
    const records = new CopilotRecords({ sessionId: ID, transcriptPath: null });
    records.ingest(
      event('session.model_change', T, { newModel: 'claude-sonnet-4.5', reasoningEffort: 'high' }),
      ID,
    );
    records.ingest(
      event('session.mode_changed', T + 1, { previousMode: 'interactive', newMode: 'plan' }),
      ID,
    );
    records.ingest(
      event('session.title_changed', T + 2, { title: 'Fix the  build' }, { ephemeral: true }),
      ID,
    );
    records.ingest(
      event(
        'session.usage_info',
        T + 3,
        { tokenLimit: 200_000, currentTokens: 50_000 },
        { ephemeral: true },
      ),
      ID,
    );
    const compacted = records.ingest(
      event('session.compaction_complete', T + 4, { success: true }),
      ID,
    );
    expect(compacted?.compactions).toStrictEqual([T + 4]);
    expect(records.summary(T + 5)).toMatchObject({
      model: 'claude-sonnet-4.5',
      effort: 'high',
      permissionMode: 'plan',
      title: 'Fix the build',
      contextFill: 0.25,
      costUsd: null,
    });
  });

  it('marks a session that shut down on an error as failed', () => {
    const records = new CopilotRecords({ sessionId: ID, transcriptPath: null });
    records.ingest(event('user.message', T, { content: 'go' }), ID);
    records.ingest(
      event('session.shutdown', T + 1, { shutdownType: 'error', modelMetrics: {} }),
      ID,
    );
    expect(records.summary(T + 2).state).toBe('failed');
    expect(records.busy()).toBe(false);
  });
});

describe('CopilotRecords and workspace.yaml', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTemporaryDirectory();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it('takes the name the user gave the session over the first prompt', async () => {
    const file = path.join(dir, 'workspace.yaml');
    await mkdir(dir, { recursive: true });
    await writeFile(file, 'id: x\ncwd: /work/other\nname: Docstring pass\nuser_named: true\n');
    const records = new CopilotRecords({
      sessionId: EDIT,
      transcriptPath: null,
      workspacePath: file,
    });
    const main = { path: 'events.jsonl', agentId: EDIT, metaPath: null };
    await records.prepare(main);
    for (const line of fixtureLines(EDIT)) {
      records.ingest(line, EDIT);
    }
    expect(records.summary(LATER)).toMatchObject({ title: 'Docstring pass', cwd: '/work/repo' });

    await writeFile(file, 'name: [not, a, string]\n');
    await records.prepare({ ...main, agentId: 'someone-else' });
    expect(records.summary(LATER).title).toBe('Docstring pass');
  });

  it('falls back to the first prompt when the file is missing', async () => {
    const records = new CopilotRecords({
      sessionId: EDIT,
      transcriptPath: null,
      workspacePath: path.join(dir, 'missing.yaml'),
    });
    await records.prepare({ path: 'events.jsonl', agentId: EDIT, metaPath: null });
    records.ingest(String(fixtureLines(EDIT)[1]), EDIT);
    expect(records.summary(LATER).title).toContain('In calc.py add the one-line docstring');
  });
});
