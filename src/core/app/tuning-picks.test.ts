import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isolatedExec } from '../sync/test-helpers/fixtures.js';

import { agentFile, FakeGitHub, skillFile } from './test-helpers/fake-github.js';
import type { TestApp } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, waitFor, writeText } from './test-helpers/fixtures.js';
import { buildTuning, rescanTuning } from './views/tuning.js';

const SESSIONS = ['aaaaaaaa-1111-4111-8111-11111111111', 'bbbbbbbb', 'cccccccc'];
const AGENT = 'categories/02-language-specialists/python-pro.md';

/** A session that runs pytest ten times. */
function lines(sessionId: string): string {
  const calls = Array.from({ length: 10 }, (_, index) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-${String(index)}`,
      timestamp: '2026-10-01T12:00:00.000Z',
      message: {
        id: `${sessionId}-m${String(index)}`,
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: [
          {
            type: 'tool_use',
            id: `${sessionId}-t${String(index)}`,
            name: 'Bash',
            input: { command: 'pytest -q' },
          },
        ],
      },
    }),
  );
  return calls.map((line) => `${line}\n`).join('');
}

async function setup(): Promise<{ test: TestApp; github: FakeGitHub }> {
  const env = await makeEnv();
  for (const sessionId of SESSIONS) {
    await writeText(
      path.join(env.paths.projectsDir, '-work', `${sessionId}.jsonl`),
      lines(sessionId),
    );
  }
  const github = new FakeGitHub({
    'VoltAgent/awesome-claude-code-subagents': {
      [AGENT]: agentFile('python-pro', 'Python expert'),
    },
    'affaan-m/ECC': {},
    'wshobson/agents': {},
    'pytest-org/skills': { 'skills/pytest-pro/SKILL.md': skillFile('pytest-pro', 'Tests.') },
  });
  github.hits = [
    {
      id: 'pytest-org/skills/pytest-pro',
      source: 'pytest-org/skills',
      skillId: 'pytest-pro',
      name: 'pytest-pro',
      installs: 900,
    },
  ];
  const test = makeApp(env, { deps: { fetch: github.fetch, exec: isolatedExec() } });
  return { test, github };
}

/** Waits for the scan to finish writing, then for the catalog search it starts. */
async function searched(test: TestApp): Promise<ReturnType<typeof buildTuning>['picks']> {
  await waitFor(() => buildTuning(test.app.runtime).scannedAt !== null);
  await rescanTuning(test.app.runtime);
  await waitFor(() => {
    const { picks } = buildTuning(test.app.runtime);
    return picks.topics.length > 0 && !picks.loading;
  });
  return buildTuning(test.app.runtime).picks;
}

describe('catalog picks in the Tuning view', () => {
  it('searches the catalogs for the work the sessions show', async () => {
    const { test } = await setup();
    const picks = await searched(test);
    expect(picks.topics).toStrictEqual(['Python']);
    expect(picks.error).toBeNull();
    expect(picks.picks.map((pick) => [pick.kind, pick.name])).toStrictEqual([
      ['skill', 'pytest-pro'],
      ['agent', 'python-pro'],
    ]);
    expect(picks.picks[0]?.reason).toBe('30 pytest commands in 3 sessions.');
  });

  it('installs a pick, then leaves it out', async () => {
    const { test } = await setup();
    const picks = await searched(test);
    const id = picks.picks.find((pick) => pick.name === 'python-pro')?.id ?? '';
    test.env.host.pickAnswers.push('user');
    await test.app.dispatch({ type: 'installPick', pickId: id }, {});
    const file = path.join(test.env.paths.userAgentsDir, 'python-pro.md');
    expect(await readFile(file, 'utf8')).toContain('Python expert');
    const after = buildTuning(test.app.runtime).picks;
    expect(after.notice).toMatchObject({ ok: true });
    expect(after.installing).toBeNull();
    expect(after.picks.map((pick) => pick.name)).toStrictEqual(['pytest-pro']);
  });

  it('opens only a pick it found, and says when a pick is gone', async () => {
    const { test } = await setup();
    const picks = await searched(test);
    await test.app.dispatch({ type: 'openPickLink', pickId: picks.picks[0]?.id ?? '' }, {});
    await test.app.dispatch({ type: 'openPickLink', pickId: 'nope' }, {});
    expect(test.env.host.external).toStrictEqual([
      'https://skills.sh/pytest-org/skills/pytest-pro',
    ]);
    await test.app.dispatch({ type: 'installPick', pickId: 'nope' }, {});
    expect(buildTuning(test.app.runtime).picks.notice).toStrictEqual({
      ok: false,
      text: 'That one is not in the list any more.',
    });
  });
});
