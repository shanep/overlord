// cspell:words rollouts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { FeedItem, ToolCall } from '../../../shared/model.js';

import { CodexRecords } from './accumulator.js';
import { commandText, rateLimitWindows, toTokenUsage } from './convert.js';
import { codexModels } from './models.js';

const ROLLOUTS = fileURLToPath(
  new URL('../../../../test/fixtures/codex/0.163.0/rollouts/', import.meta.url),
);

const PLAIN = '01a1480a-6060-7fc1-8932-a87d32a8bac6';
const SHELL = '01a1480a-a59d-7a22-b52b-57cb2efc73dc';
const EDIT = '01a1480a-d128-7ff0-b026-896f6f880226';
const APP_SERVER = '01a1480b-e3ce-72c0-a983-d84252bd9063';

const FILES: Readonly<Record<string, string>> = {
  [PLAIN]: 'rollout-2026-10-16T22-06-42-01a1480a-6060-7fc1-8932-a87d32a8bac6.jsonl',
  [SHELL]: 'rollout-2026-10-16T22-06-59-01a1480a-a59d-7a22-b52b-57cb2efc73dc.jsonl',
  [EDIT]: 'rollout-2026-10-16T22-07-10-01a1480a-d128-7ff0-b026-896f6f880226.jsonl',
  [APP_SERVER]: 'rollout-2026-10-16T22-08-21-01a1480b-e3ce-72c0-a983-d84252bd9063.jsonl',
};

function lines(sessionId: string): string[] {
  const file = path.join(ROLLOUTS, FILES[sessionId] ?? '');
  return readFileSync(file, 'utf8').split('\n');
}

interface Replay {
  readonly records: CodexRecords;
  readonly tools: ToolCall[];
  readonly requests: number;
  readonly feed: FeedItem[];
  readonly last: number;
}

function replay(sessionId: string, take = Number.POSITIVE_INFINITY): Replay {
  const records = new CodexRecords({ sessionId, transcriptPath: `/sessions/${sessionId}.jsonl` });
  const tools: ToolCall[] = [];
  const feed: FeedItem[] = [];
  let requests = 0;
  for (const line of lines(sessionId).slice(0, take)) {
    const delta = records.ingest(line, sessionId);
    tools.push(...(delta?.tools ?? []));
    feed.push(...(delta?.feed ?? []));
    requests += delta?.requests.length ?? 0;
  }
  return { records, tools, requests, feed, last: records.summary(0).updatedAt };
}

describe('CodexRecords', () => {
  it('reads a plain answer: folder, model, title, one call and an idle state', () => {
    const { records, tools, requests, feed, last } = replay(PLAIN);
    const summary = records.summary(last + 1000);
    expect(summary).toMatchObject({
      id: PLAIN,
      agent: 'codex',
      surface: 'cli',
      title: 'Reply with the single word: pong. Do not run any commands.',
      cwd: '/work/repo',
      state: 'idle',
      model: 'gpt-6-luna',
      effort: 'low',
      permissionMode: 'never/read-only',
      gitBranch: 'master',
      version: '0.163.0',
      costUsd: null,
      agentCount: 0,
      transcriptPath: `/sessions/${PLAIN}.jsonl`,
    });
    expect(summary.usage).toStrictEqual({
      input: 13_279 - 11_008,
      output: 5,
      cacheRead: 11_008,
      cacheCreation: 0,
      thinking: 0,
    });
    expect(summary.contextFill).toBeCloseTo(13_279 / 258_400);
    expect(requests).toBe(1);
    expect(tools).toStrictEqual([]);
    expect(feed.map((item) => item.kind)).toStrictEqual(['user', 'text']);
    expect(records.busy()).toBe(false);
    expect(records.formatVerified()).toBe(true);
    expect(records.agents(last).map((agent) => [agent.id, agent.agentType])).toStrictEqual([
      [PLAIN, 'main'],
    ]);
  });

  it('counts each call once though Codex writes its usage twice', () => {
    const { records, requests } = replay(EDIT);
    expect(requests).toBe(3);
    expect(records.requests().map((request) => request.messageId)).toHaveLength(3);
    expect(records.summary(0).usage).toMatchObject({
      input: 40_922 - 37_888,
      cacheRead: 37_888,
      output: 106,
    });
  });

  it('shows the real command and edit, not the JavaScript the model sent', () => {
    const { tools, feed } = replay(EDIT);
    expect(tools.map((tool) => [tool.name, tool.ok])).toStrictEqual([
      ['exec_command', true],
      ['apply_patch', true],
    ]);
    expect(tools[0]).toMatchObject({
      id: 'exec-c70eb633-8ac7-43a0-b313-57fd340a3855',
      input: { command: 'cat notes.txt', cwd: '/work/repo' },
      resultPreview: 'hello\n',
    });
    expect(tools[1]?.input).toStrictEqual({
      changes: [
        { path: '/work/repo/notes.txt', kind: 'update', diff: '@@ -1 +1,2 @@\n hello\n+world\n' },
      ],
    });
    expect(feed.filter((item) => item.kind === 'tool_use')).toHaveLength(2);
    expect(JSON.stringify(feed)).not.toContain('tools.exec_command');
  });

  it('reads one ls from the shell run', () => {
    const { tools } = replay(SHELL);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.input).toMatchObject({ command: 'ls' });
  });

  it('shows a declined approval as a failed command and an interrupt as a stopped turn', () => {
    const { records, tools, feed, last } = replay(APP_SERVER);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: 'call_b73bbeb2cb8746819887c6191170f714',
      name: 'exec_command',
      input: { command: 'touch approved.txt' },
      ok: false,
      resultPreview: 'Rejected by user',
    });
    expect(feed.at(-1)).toMatchObject({ kind: 'system', text: 'Turn stopped (interrupted)' });
    expect(records.busy()).toBe(false);
    expect(records.summary(last).state).toBe('idle');
    expect(records.summary(last).permissionMode).toBe('untrusted/read-only');
    expect(records.summary(last).lastPrompt).toBe(
      'Without running any commands, write a 400 word story about a lighthouse.',
    );
    expect(records.requests()).toHaveLength(2);
  });

  it('is busy during a turn and running while the turn is recent', () => {
    // Up to the first token_usage_record of the shell run, mid-turn.
    const { records, last } = replay(SHELL, 13);
    expect(records.busy()).toBe(true);
    expect(records.summary(last + 1000).state).toBe('running');
    expect(records.summary(last + 60 * 60 * 1000).state).toBe('idle');
  });

  it('keeps the newest rate limit window and teaches the models facet the window', () => {
    const { records } = replay(PLAIN);
    expect(records.rateLimits()).toStrictEqual([
      {
        agent: 'codex',
        id: 'primary',
        label: '30 day',
        usedPct: 0,
        resetsAt: 1_794_802_004_000,
      },
    ]);
    expect(codexModels.contextWindow('gpt-6-luna')).toBe(258_400);
    expect(codexModels.contextWindow('gpt-6-luna', 300_000)).toBe(300_000);
    expect(codexModels.contextWindow('no-such-model')).toBeNull();
    expect(codexModels.contextWindow(null)).toBeNull();
    expect(codexModels.price('gpt-6-luna')).toBeNull();
  });

  it('skips lines it does not read and keeps going', () => {
    const records = new CodexRecords({ sessionId: 's' });
    expect(records.ingest('', 's')).toBeNull();
    expect(records.ingest('not json', 's')).toBeNull();
    expect(records.ingest('"a string"', 's')).toBeNull();
    const unknown = records.ingest(
      JSON.stringify({ timestamp: 'x', type: 'brand_new', payload: {} }),
      's',
    );
    expect(unknown).toMatchObject({ tools: [], requests: [], feed: [] });
    const odd = records.ingest(
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: 7 } }),
      's',
    );
    expect(odd).not.toBeNull();
    expect(records.summary(0)).toMatchObject({ title: '', cwd: '', state: 'unknown', model: null });
  });

  it('says when a Codex version it has not checked wrote the file', () => {
    const records = new CodexRecords({ sessionId: 's' });
    const meta = {
      timestamp: '2026-10-17T04:07:11.408Z',
      type: 'session_meta',
      payload: { cli_version: '0.170.0', cwd: '/w' },
    };
    const delta = records.ingest(JSON.stringify(meta), 's');
    expect(delta?.feed[0]).toMatchObject({ kind: 'system' });
    expect(delta?.feed[0]?.kind === 'system' ? delta.feed[0].text : '').toContain(
      'Format not verified',
    );
    expect(records.formatVerified()).toBe(false);
    expect(records.ingest(JSON.stringify(meta), 's')?.feed).toStrictEqual([]);
  });
});

function window(minutes: number | null): {
  used_percent: number;
  window_minutes: number | null;
  resets_at: null;
} {
  return { used_percent: 5, window_minutes: minutes, resets_at: null };
}

describe('Codex helpers', () => {
  it('turns Codex usage into the shared model, cached input kept apart', () => {
    expect(
      toTokenUsage({
        input_tokens: 100,
        cached_input_tokens: 60,
        cache_write_input_tokens: 10,
        output_tokens: 7,
        reasoning_output_tokens: 3,
      }),
    ).toStrictEqual({ input: 30, output: 7, cacheRead: 60, cacheCreation: 10, thinking: 3 });
  });

  it('shows the script a shell wrapper runs', () => {
    expect(commandText(['/bin/zsh', '-lc', 'ls -la'])).toBe('ls -la');
    expect(commandText(['git', 'status'])).toBe('git status');
    expect(commandText('echo hi')).toBe('echo hi');
    expect(commandText(null)).toBe('');
  });

  it('labels rate limit windows by length', () => {
    expect(
      rateLimitWindows({
        limit_id: 'codex',
        primary: window(300),
        secondary: window(10_080),
        plan_type: 'plus',
      }).map((entry) => entry.label),
    ).toStrictEqual(['5 hour', '7 day']);
    expect(
      rateLimitWindows({
        limit_id: null,
        primary: window(45),
        secondary: window(null),
        plan_type: null,
      }).map((entry) => entry.label),
    ).toStrictEqual(['45 minute', 'Limit']);
  });
});
