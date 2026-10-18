import { describe, expect, it } from 'vitest';

import { DEFAULT_PRICES } from '../transcripts/pricing.js';
import {
  assistant,
  attachment,
  system,
  text,
  toolResult,
  toolUse,
  usage,
  userPrompt,
} from '../transcripts/test-helpers/fixtures.js';

import { attribute } from './attribute.js';
import { addSpend, CHARS_PER_TOKEN, SPEND_SOURCES, skillName, zeroSpend } from './spend.js';

type Fields = Readonly<Record<string, unknown>>;

function lines(records: readonly Fields[]): string[] {
  return records.map((record) => JSON.stringify(record));
}

/** One request on Opus 5.5 that read `cacheRead` tokens of context. */
function request(id: string, cacheRead: number, content: readonly Fields[] = []): Fields {
  return assistant({
    uuid: `a-${id}`,
    at: 0,
    messageId: id,
    content,
    usage: usage({ cacheRead }),
  });
}

function total(spend: Readonly<Record<string, number>>): number {
  return Object.values(spend).reduce((sum, value) => sum + value, 0);
}

const FILE = 'x'.repeat(36_000);
const FILE_TOKENS = FILE.length / CHARS_PER_TOKEN;

describe('attribute', () => {
  it('charges setup for the first request and a file for every request it stays in context', () => {
    const result = attribute(
      lines([
        request('r1', 10_000, [toolUse('t1', 'Read', { file_path: '/work/demo/src/app.ts' })]),
        toolResult('u1', 1, [{ toolUseId: 't1', text: FILE }]),
        request('r2', 10_000 + FILE_TOKENS),
        request('r3', 10_000 + FILE_TOKENS),
      ]),
      DEFAULT_PRICES,
    );
    const perRequest = (FILE_TOKENS * 0.2) / 1_000_000;
    expect(result.spend.fileReads + result.spend.toolInputs).toBeCloseTo(2 * perRequest, 9);
    expect(result.spend.fileReads).toBeGreaterThan(2 * perRequest * 0.99);
    expect(total(result.spend)).toBeCloseTo(((30_000 + 2 * FILE_TOKENS) * 0.2) / 1_000_000, 9);
    expect(result.files).toStrictEqual({ '/work/demo/src/app.ts': result.spend.fileReads });
    expect(result.heavy[0]).toMatchObject({
      source: 'fileReads',
      label: 'Read /work/demo/src/app.ts',
      tokens: 10_000,
    });
    expect(result.toolUses).toStrictEqual({ Read: 1 });
  });

  it('stops charging what a compaction dropped', () => {
    const result = attribute(
      lines([
        request('r1', 1000, [toolUse('t1', 'Bash', { command: 'cat a.ts b.ts' })]),
        toolResult('u1', 1, [{ toolUseId: 't1', text: FILE }]),
        request('r2', 1000 + FILE_TOKENS),
        system('s1', 2, { subtype: 'compact_boundary' }),
        request('r3', 1000),
        request('r4', 1000),
      ]),
      DEFAULT_PRICES,
    );
    const charged = result.spend.fileReads;
    expect(charged).toBeGreaterThan(0);
    expect(
      Object.keys(result.files).toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(['a.ts', 'b.ts']);
    expect(result.spend.setup).toBeCloseTo((4 * 1000 * 0.2) / 1_000_000, 9);
    expect(
      result.heavy.map((item) => item.label).toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(['Bash a.ts', 'Bash b.ts', 'Bash cat a.ts b.ts']);
  });

  it('sorts skills, instructions, reminders, prompts and output into their own sources', () => {
    const result = attribute(
      lines([
        request('r1', 5000),
        userPrompt('p1', 1, 'Fix the login bug'),
        userPrompt(
          'p2',
          2,
          'Base directory for this skill: /home/me/.claude/skills/voice\n\nBody',
          {
            isMeta: true,
          },
        ),
        userPrompt(
          'p3',
          3,
          '<system-reminder>Contents of /home/me/CLAUDE.md: rules</system-reminder>',
          {
            isMeta: true,
          },
        ),
        {
          ...attachment('t1', 4, {
            type: 'hook_additional_context',
            content: ['Overlord says hi'],
            hookName: 'SessionStart',
          }),
        },
        {
          ...attachment('t2', 5, { type: 'skill_listing' }),
          rendered: [{ content: 'skills: a, b' }],
        },
        assistant({
          uuid: 'a2',
          at: 6,
          messageId: 'r2',
          content: [text('Done.'), toolUse('t9', 'WebFetch', { url: 'https://example.com' })],
          usage: usage({ cacheRead: 6000, output: 1000 }),
        }),
        toolResult('u9', 7, [{ toolUseId: 't9', text: 'page text' }]),
        request('r3', 6100),
      ]),
      DEFAULT_PRICES,
    );
    for (const source of [
      'skills',
      'instructions',
      'reminders',
      'conversation',
      'web',
      'output',
    ] as const) {
      expect([source, result.spend[source] > 0]).toStrictEqual([source, true]);
    }
    expect(Object.keys(result.skills)).toStrictEqual(['/home/me/.claude/skills/voice']);
    expect(result.spend.output).toBeCloseTo((1000 * 20) / 1_000_000, 9);
  });

  it('splits setup between tool definitions by size when the request shape is logged', () => {
    const result = attribute(
      [
        JSON.stringify({
          type: 'api-request-shape',
          shape: {
            system: [{ type: 'text', text: 'You are Claude Code.' }],
            tools: [
              { name: 'Big', d: 'x'.repeat(900) },
              { name: 'Small', d: 'x' },
            ],
          },
        }),
        ...lines([request('r1', 10_000), request('r2', 10_000)]),
        'not json',
      ],
      DEFAULT_PRICES,
    );
    const big = result.toolSchemas['Big'] ?? 0;
    const small = result.toolSchemas['Small'] ?? 0;
    expect(big).toBeGreaterThan(small * 30);
    expect(big + small).toBeLessThan(result.spend.setup);
  });

  it('adds spend splits and names skills by folder', () => {
    const one = { ...zeroSpend(), setup: 1 };
    expect(addSpend(one, one).setup).toBe(2);
    expect(SPEND_SOURCES).toHaveLength(11);
    expect(skillName('/home/me/.claude/skills/voice/')).toBe('voice');
  });
});
