// Lint only the files that changed, so the pre-push hook takes seconds instead
// of the four minutes a full lint takes in a fresh worktree with no cache.
// Compares against LINT_BASE or origin/master, and includes uncommitted
// changes. A change to the lint, TypeScript or package setup lints everything,
// since it can break files that did not change. CI still runs the full lint.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

const base = process.env.LINT_BASE ?? 'origin/master';
const LINTED = /\.(?:ts|tsx|mjs|cjs)$/u;
const SETUP = /(?:^|\/)(?:eslint\.config\.mjs|package(?:-lock)?\.json|tsconfig[^/]*\.json)$/u;

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

const changed = changedFiles();
const targets = changed.some((file) => SETUP.test(file))
  ? ['.']
  : changed.filter((file) => LINTED.test(file) && existsSync(file)).toSorted();

if (targets.length === 0) {
  process.stdout.write(`No changed files to lint since ${base}.\n`);
} else {
  const result = spawnSync(
    'npx',
    [
      'eslint',
      '--max-warnings',
      '0',
      '--no-warn-ignored',
      '--cache',
      '--cache-location',
      '.cache/eslint/',
      ...targets,
    ],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}
