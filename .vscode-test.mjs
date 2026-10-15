import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.cjs',
  mocha: { ui: 'bdd', timeout: 20_000 },
});
