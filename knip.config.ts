import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'src/host/extension.ts',
    'src/hook/main.ts',
    'webview/src/main.tsx',
    'webview/vite.config.ts',
    'scripts/*.mjs',
    'stryker.fast.config.mjs',
    'test/fake-claude/*.mjs',
    'test/integration/**/*.ts',
  ],
  // Loaded by @vscode/test-cli at runtime, not imported.
  ignoreDependencies: ['@vscode/test-electron'],
  project: ['src/**/*.ts', 'webview/**/*.{ts,tsx}', 'scripts/**/*.mjs', 'test/**/*.{ts,mjs}'],
};

export default config;
