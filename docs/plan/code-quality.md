# Code quality and testing

Everything at its strictest setting, enforced in CI, zero warnings allowed.

TypeScript:

- `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noImplicitReturns`, `noPropertyAccessFromIndexSignature`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
  `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`,
  `allowUnreachableCode: false`, `allowUnusedLabels: false`.
- `@tsconfig/strictest` as the base so nothing is missed.
- `type-coverage --strict --at-least 100`. No `any`, and every `as` cast needs
  a comment saying why (same rule as `cast()` in Python).
- All external data (transcripts, hook JSON, OTel, settings files) is parsed
  with zod schemas at the boundary, so bad input is a typed error, not a crash.

Linting and checks:

- ESLint flat config with `typescript-eslint` `strictTypeChecked` and
  `stylisticTypeChecked`, plus `unicorn`, `sonarjs`, `import-x`, `promise`,
  `n`, `regexp`, `security`, `react`, `react-hooks`, `jsx-a11y`, and
  `@vitest/eslint-plugin`. `--max-warnings 0`.
- Prettier for formatting, checked in CI.
- knip for unused files, exports and dependencies.
- dependency-cruiser for layer rules: `core/` cannot import `vscode`,
  webviews cannot import Node, no cycles.
- cspell, markdownlint, and a small script that fails the build on any em dash
  or en dash in the repo.
- `npm audit`, osv-scanner, and CodeQL for dependencies and security.
- publint and a bundle size budget for the packaged extension.
- lefthook runs lint, types and unit tests before each commit.

Tests:

- **Unit (Vitest)**: 100% line, branch, function and statement coverage on
  `core/`, enforced as a threshold. `core/` has no vscode imports, which is
  what makes 100% realistic.
- **Property tests (fast-check)** for parsers, the layer merge, and the
  context resolver.
- **Mutation tests (Stryker)** on `core/`, break threshold 90%, so tests have
  to actually check behavior and not just run lines.
- **Contract tests** against a fixture corpus of real, scrubbed transcripts,
  hook payloads and OTel exports from each Claude Code version we support. A
  new version adds fixtures, and any format change fails loudly.
- **Fake Claude**: a stub binary passed to the SDK as
  `pathToClaudeCodeExecutable` that replays recorded stream-json, so launcher
  and fleet tests run without the API or cost.
- **Integration (`@vscode/test-electron`)**: activation, commands, tree views,
  hook install and removal, settings round trips.
- **Webview tests**: Vitest with jsdom and Testing Library for every view and
  component, plus axe accessibility checks on every view. Playwright visual
  snapshots of each chart in light and dark themes are still to do.
- **Sync tests**: apply, diff and revert against a temp HOME and a temp git
  remote, on macOS and Linux.
- **CI**: GitHub Actions matrix on macOS and Ubuntu, every check above
  required to pass.
