import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'src/host/extension.ts',
    'src/hook/main.ts',
    'src/proxy/main.ts',
    'src/leaderboard/worker.ts',
    'webview/src/main.tsx',
    'webview/vite.config.ts',
    'scripts/*.mjs',
    'stryker.fast.config.mjs',
    'test/fake-claude/*.mjs',
    'test/integration/**/*.ts',
  ],
  // @vscode/test-electron is loaded by @vscode/test-cli at runtime, not imported.
  // type-coverage runs through scripts/slot.mjs, where knip cannot see the binary.
  ignoreDependencies: ['@vscode/test-electron', 'type-coverage'],
  // no-real-api.test.ts names these agent CLIs to check that tests never start them.
  ignoreBinaries: ['agy', 'codex', 'gemini.cmd'],
  project: ['src/**/*.ts', 'webview/**/*.{ts,tsx}', 'scripts/**/*.mjs', 'test/**/*.{ts,mjs}'],
};

export default config;
