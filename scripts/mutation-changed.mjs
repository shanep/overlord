// Mutation test only the source files that changed, so a run takes a minute or
// two instead of the full sweep. Compares against MUTATION_BASE (CI sets it)
// or origin/master, and includes uncommitted changes. A changed test file
// counts as a change to the source file it tests.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

const base = process.env.MUTATION_BASE ?? 'origin/master';
const MUTABLE = /^src\/(?:core|shared)\/.+\.ts$/u;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function changedFiles() {
  const committed = git(['diff', '--name-only', `${base}...HEAD`]);
  const working = git(['diff', '--name-only', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...committed, ...working, ...untracked])];
}

function sourceFor(file) {
  if (!MUTABLE.test(file) || file.includes('/test-helpers/')) {
    return null;
  }
  const source = file.endsWith('.test.ts') ? file.replace(/\.test\.ts$/u, '.ts') : file;
  return existsSync(source) ? source : null;
}

const targets = [
  ...new Set(
    changedFiles()
      .map((file) => sourceFor(file))
      .filter((file) => file !== null),
  ),
].toSorted();

if (targets.length === 0) {
  process.stdout.write(`No changed source files under src/core or src/shared since ${base}.\n`);
} else {
  process.stdout.write(
    `Mutating ${String(targets.length)} changed file(s):\n  ${targets.join('\n  ')}\n`,
  );
  const result = spawnSync(
    'npx',
    ['stryker', 'run', 'stryker.fast.config.mjs', '--mutate', targets.join(',')],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}
