import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { bridgeUsageFile, logUsage, summarizeUsage } from './usage-log.js';

const OPUS = 'global.anthropic.claude-opus-5-5';
const at = (day: number, hour: number): number => new Date(2026, 9, day, hour).getTime();
const line = (when: number, model: string, inputTokens: number, outputTokens: number): string =>
  JSON.stringify({ at: when, model, inputTokens, outputTokens });

describe('bridgeUsageFile', () => {
  it('lives in Overlord’s folder under home', () => {
    expect(bridgeUsageFile('/home/u')).toBe(
      path.join('/home/u', '.overlord', 'boisestate-usage.jsonl'),
    );
  });
});

describe('logUsage', () => {
  it('appends one line per call, making the folder, and reports a failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-usage-'));
    const file = path.join(dir, 'nested', 'usage.jsonl');
    const problems: string[] = [];
    const usage = { model: OPUS, inputTokens: 10, outputTokens: 2 };
    await logUsage(file, usage, 5, (message) => problems.push(message));
    await logUsage(file, usage, 6, (message) => problems.push(message));
    const written = await readFile(file, 'utf8');
    expect(written.trim().split('\n')).toStrictEqual([
      JSON.stringify({ at: 5, ...usage }),
      JSON.stringify({ at: 6, ...usage }),
    ]);
    const blocked = path.join(dir, 'blocked');
    await writeFile(blocked, '');
    await logUsage(path.join(blocked, 'usage.jsonl'), usage, 7, (message) =>
      problems.push(message),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^could not log usage: /u);
  });
});

describe('summarizeUsage', () => {
  it('sums calls by local day and by model, skipping lines it cannot read', () => {
    const text = [
      line(at(17, 9), OPUS, 100, 10),
      'not json',
      '{"at":1}',
      line(at(16, 23), 'google.gemma-4-31b', 5, 5),
      line(at(17, 10), OPUS, 200, 20),
      '',
    ].join('\n');
    expect(summarizeUsage(text)).toStrictEqual({
      days: [
        { date: '2026-10-16', calls: 1, inputTokens: 5, outputTokens: 5 },
        { date: '2026-10-17', calls: 2, inputTokens: 300, outputTokens: 30 },
      ],
      models: [
        { model: OPUS, calls: 2, inputTokens: 300, outputTokens: 30 },
        { model: 'google.gemma-4-31b', calls: 1, inputTokens: 5, outputTokens: 5 },
      ],
    });
  });

  it('is null with no calls logged', () => {
    expect(summarizeUsage('')).toBeNull();
    expect(summarizeUsage('garbage\n')).toBeNull();
  });
});
