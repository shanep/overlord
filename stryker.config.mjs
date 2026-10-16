export default {
  testRunner: 'vitest',
  // Keep downloads and build output out of the sandbox copy.
  ignorePatterns: ['.vscode-test', 'out', 'dist', 'coverage', 'reports', '*.vsix'],
  vitest: { configFile: 'vitest.config.ts' },
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  typescriptChecker: { prioritizePerformanceOverAccuracy: true },
  mutate: [
    'src/core/**/*.ts',
    'src/shared/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/test-helpers/**',
  ],
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 95, low: 90, break: 90 },
  ignoreStatic: true,
};
