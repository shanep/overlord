import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig } from '@vscode/test-cli';

// Point Claude Code paths at an empty temp dir so tests never read or write the real ~/.claude.
const claudeConfigDir = mkdtempSync(path.join(os.tmpdir(), 'overlord-it-'));

export default defineConfig({
  files: 'out/test/integration/**/*.test.cjs',
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
  mocha: { ui: 'bdd', timeout: 20_000 },
});
