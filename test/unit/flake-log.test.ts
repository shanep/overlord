import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { RunEntry, TestResult } from '../../scripts/flake-log.mjs';
import { appendLog, failedAt, findFlakes, readLog, runEntry } from '../../scripts/flake-log.mjs';

const OK = (id: string, file: string): TestResult => ({ id, file, state: 'passed' });
const BAD = (id: string, file: string, message = 'boom'): TestResult => ({
  id,
  file,
  state: 'failed',
  message,
});

function entry(
  at: number,
  print: string,
  results: readonly TestResult[],
  prior = new Set<string>(),
): RunEntry {
  return runEntry({ at, cwd: `/w/${String(at)}`, fingerprint: print, results, priorFailed: prior });
}

describe('flake log', () => {
  it('keeps failures, files that fully passed and earlier failures that now pass', () => {
    const line = entry(
      1,
      'fp',
      [
        OK('a > one', 'a'),
        BAD('a > two', 'a', 'x'.repeat(400)),
        OK('b > one', 'b'),
        OK('c > one', 'c'),
      ],
      new Set(['c > one']),
    );
    expect(line.failed).toStrictEqual([{ id: 'a > two', file: 'a', message: 'x'.repeat(300) }]);
    expect(line.passedFiles).toStrictEqual(['b', 'c']);
    expect(line.passed).toStrictEqual(['c > one']);
  });

  it('finds tests that failed and passed on the same code, and not ones that changed', () => {
    const entries = [
      entry(1, 'same', [BAD('a > flaky', 'a', 'ENOTEMPTY')]),
      entry(2, 'same', [OK('a > flaky', 'a')], new Set(['a > flaky'])),
      entry(3, 'same', [BAD('a > flaky', 'a', 'ENOTEMPTY again'), OK('a > other', 'a')]),
      // Failed, then passed only after the code changed: a fix, not a flake.
      entry(4, 'before', [BAD('b > fixed', 'b')]),
      entry(5, 'after', [OK('b > fixed', 'b')]),
      // Passed with its whole file first, then failed on the same code.
      entry(6, 'whole', [OK('c > one', 'c')]),
      entry(7, 'whole', [BAD('c > one', 'c', 'timeout')]),
    ];
    expect(findFlakes(entries)).toStrictEqual([
      {
        id: 'a > flaky',
        file: 'a',
        failures: 2,
        lastAt: 3,
        lastMessage: 'ENOTEMPTY again',
        worktrees: 2,
      },
      { id: 'c > one', file: 'c', failures: 1, lastAt: 7, lastMessage: 'timeout', worktrees: 1 },
    ]);
    expect(failedAt(entries, 'same')).toStrictEqual(new Set(['a > flaky']));
    expect(findFlakes(entries.map((line) => ({ ...line, fingerprint: null })))).toStrictEqual([]);
  });

  it('appends lines, skips broken ones and cuts a log that grew too big', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'overlord-flakes-'));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const file = path.join(root, 'deep', 'runs.jsonl');
    expect(readLog(file)).toStrictEqual([]);
    appendLog(file, entry(1, 'fp', []));
    await writeFile(file, `${await readFile(file, 'utf8')}not json\n`);
    appendLog(file, entry(2, 'fp', []));
    expect(readLog(file).map((line) => line.at)).toStrictEqual([1, 2]);
    const big = `${JSON.stringify(entry(0, 'fp', []))}\n`.repeat(80_000);
    await writeFile(file, big);
    appendLog(file, entry(9, 'fp', []));
    const kept = readLog(file);
    expect(kept.length).toBeLessThan(45_000);
    expect(kept.at(-1)?.at).toBe(9);
  });
});
