# Overlord

Many sessions run against this repo at once on one machine, so every heavy
command you run slows down all the others. Keep checks small.

## Checking your work

The git hooks are the checks. Do not run `npm run check`, `npm run lint`,
`npm test` or `npm run test:coverage` by hand. A full check takes 3 to 7
minutes and CI runs it on every push anyway.

- While you work, run the tests for the files you touched and the incremental
  typecheck:

  ```sh
  npm run -s test:related -- src/core/foo.ts src/core/foo.test.ts
  npm run -s typecheck:fast
  ```

- Heavy scripts (tsc, eslint, vitest, stryker) take turns with other
  sessions through `scripts/slot.mjs`, so one may print "Waiting for a free
  check slot" and sit for a while. That is not a hang. Give the command a
  timeout of 10 minutes or run it in the background, and do not kill it and
  start it again. Run these through npm scripts, not `npx`, so they wait
  their turn.

- `git commit` runs typecheck, lint, format and the related tests on the
  staged files. If it passes, the commit is checked.
- `git push` runs `npm run check:fast`, which lints and tests what changed
  since `origin/master` and runs the spell check, knip and type coverage over
  the whole repo (about 20 seconds). Those three broke master most often when
  only CI ran them. After a rebase, the push reruns it, so there is nothing to
  run by hand first.
- Leave mutation testing, coverage and the rest of the full gate to CI unless
  you are fixing one of them.

Run a command once and read its log. Do not rerun a passing check to confirm
it, and do not rerun the whole suite to see one failing test.

## Setup

Overlord clones `node_modules` into new worktrees. Only run `npm ci` when
`node_modules` is missing.
