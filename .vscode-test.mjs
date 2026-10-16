import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig } from '@vscode/test-cli';

// Point Claude Code paths at an empty temp dir so tests never read or write the real ~/.claude.
const claudeConfigDir = mkdtempSync(path.join(os.tmpdir(), 'overlord-it-'));

export default defineConfig({
  files: 'out/test/integration/**/*.test.cjs',
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  // Same guard as the unit tests: no real API calls, ever.
  env: {
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: 'overlord-test-no-key',
    CLAUDE_CODE_MAX_RETRIES: '0',
  },
  mocha: { ui: 'bdd', timeout: 20_000 },
});
