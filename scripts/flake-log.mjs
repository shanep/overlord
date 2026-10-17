// The test run log behind npm run flakes. Every vitest run on this machine
// adds one line: a fingerprint of the code it ran (the commit plus any
// uncommitted and untracked changes), the tests that failed, and evidence of
// tests that passed. A test that failed and passed on the same fingerprint is
// flaky: nothing changed but the result. Sessions used to rerun a red check
// until it went green, so the same flake cost every session that met it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Past this size the log keeps its newest half. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MESSAGE_CHARS = 300;

export function defaultLogPath() {
  return path.join(os.homedir(), '.cache', 'overlord', 'test-runs.jsonl');
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** A hash of HEAD's tree, the uncommitted diff and the untracked files, or null outside git. */
export function fingerprint(cwd) {
  const tree = git(['rev-parse', 'HEAD^{tree}'], cwd);
  const diff = git(['diff', 'HEAD', '--binary'], cwd);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  if (tree === null || diff === null || untracked === null) {
    return null;
  }
  const hash = createHash('sha256').update(tree).update(diff);
  for (const file of untracked.toString('utf8').split('\0').filter(Boolean).toSorted()) {
    hash.update(file);
    try {
      hash.update(readFileSync(path.join(cwd, file)));
    } catch {
      // Gone since the listing, so the name alone counts.
    }
  }
  return hash.digest('hex').slice(0, 24);
}

/**
 * One run's line. `results` is every test with its file, state and first
 * error. Passing tests are kept only as the files whose every test passed,
 * plus the ids that failed on this fingerprint before, so a line stays small.
 */
export function runEntry({ at, cwd, fingerprint: print, results, priorFailed }) {
  const failed = [];
  const passed = [];
  const fileFailed = new Map();
  for (const result of results) {
    const bad = result.state === 'failed';
    fileFailed.set(result.file, (fileFailed.get(result.file) ?? false) || bad);
    if (bad) {
      failed.push({
        id: result.id,
        file: result.file,
        message: (result.message ?? '').slice(0, MESSAGE_CHARS),
      });
    } else if (result.state === 'passed' && priorFailed.has(result.id)) {
      passed.push(result.id);
    }
  }
  const passedFiles = [...fileFailed].filter(([, bad]) => !bad).map(([file]) => file);
  return { at, cwd, fingerprint: print, failed, passed, passedFiles };
}

export function readLog(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line === '' ? [] : [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** Adds a line, first cutting the log to its newest half when it grew too big. */
export function appendLog(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (statSync(file).size > MAX_LOG_BYTES) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
    }
  } catch {
    // No log yet.
  }
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/** Ids that failed on this fingerprint in earlier runs. */
export function failedAt(entries, print) {
  return new Set(
    entries
      .filter((entry) => entry.fingerprint === print)
      .flatMap((entry) => entry.failed.map((failure) => failure.id)),
  );
}

function byFingerprint(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.fingerprint) {
      groups.set(entry.fingerprint, [...(groups.get(entry.fingerprint) ?? []), entry]);
    }
  }
  return groups.values();
}

function addFailure(flakes, failure, run) {
  const known = flakes.get(failure.id) ?? {
    id: failure.id,
    file: failure.file,
    failures: 0,
    lastAt: 0,
    lastMessage: '',
    cwds: new Set(),
  };
  known.failures += 1;
  known.cwds.add(run.cwd);
  if (run.at >= known.lastAt) {
    known.lastAt = run.at;
    known.lastMessage = failure.message;
  }
  flakes.set(failure.id, known);
}

/**
 * Tests that failed and also passed on the same code, most often first. A
 * pass counts when the test passed by id or its whole file passed.
 */
export function findFlakes(entries) {
  const flakes = new Map();
  for (const runs of byFingerprint(entries)) {
    const passedIds = new Set(runs.flatMap((run) => run.passed));
    const passedFiles = new Set(runs.flatMap((run) => run.passedFiles));
    for (const run of runs) {
      for (const failure of run.failed) {
        if (passedIds.has(failure.id) || passedFiles.has(failure.file)) {
          addFailure(flakes, failure, run);
        }
      }
    }
  }
  return [...flakes.values()]
    .map(({ cwds, ...flake }) => ({ ...flake, worktrees: cwds.size }))
    .toSorted((left, right) => right.failures - left.failures || right.lastAt - left.lastAt);
}
