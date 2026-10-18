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

- `git commit` runs typecheck, lint, format, a secret scan and the related
  tests on the staged files. If it passes, the commit is checked. When the
  secret scan stops a commit, take the key out. A made-up key in a test gets
  `// secretlint-disable-next-line` on the line above it.
- `git push` runs `npm run check:fast`, which lints and tests what changed
  since `origin/master` and runs the spell check, markdown lint, knip,
  dependency-cruiser and type coverage over the whole repo (about 25 seconds).
  Those broke master most often when only CI ran them. After a rebase, the
  push reruns it, so there is nothing to run by hand first.
- Leave mutation testing, coverage and the integration tests to CI unless you
  are fixing one of them.

Run a command once and read its log. Do not rerun a passing check to confirm
it, and do not rerun the whole suite to see one failing test.

When a test fails in code you did not touch, run `npm run flakes`. Every
vitest run on this machine is logged, and it lists tests that failed and
passed on the same code, with the last error. A test on that list is flaky:
fix the flake (usually a race or a shared temp folder) instead of rerunning
until it passes.

## Landing

Land finished work with `npm run land` instead of rebasing and pushing by
hand. Give it a 20 minute timeout or run it in the background.

- It reviews the change first: a fresh Claude session on Sonnet reads the
  diff and stops the landing when it finds a real bug, with the file, the
  problem and a fix. Fix it, commit and land again. When a finding is wrong,
  land again with `npm run land -- --accept-review`. Changes under 30 lines
  are not reviewed.
- Then it takes the repository's land lock, so only one session lands at a
  time, rebases onto `origin/master`, pushes (the pre-push hook runs the
  checks once) and confirms the commit is on master. "Waiting for another
  session to land" is not a hang.
- Exit 0 means landed, 1 means something failed (it says what), and 2 means
  the review found a blocking problem.

## Installing the extension

After landing any user-visible Overlord change, run `npm run install:local`
without waiting to be asked. It packages the landed `HEAD`, installs it into
VS Code, reloads open windows, and checks every view against real data.
It refuses a `HEAD` with commits that have not landed, so land first.
Do not report the work complete until it reports that the extension reloaded
and its self-check passed. If a reload is held for Launcher runs, report that
it will happen automatically after they finish.

## Setup

Overlord clones `node_modules` into new worktrees. Only run `npm ci` when
`node_modules` is missing.
