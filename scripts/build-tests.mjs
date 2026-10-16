// Bundle the VS Code integration tests so the test host can load them as CommonJS.
import { readdirSync } from 'node:fs';
import path from 'node:path';

import * as esbuild from 'esbuild';

const dir = 'test/integration';
const entryPoints = readdirSync(dir)
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => path.join(dir, file));

await esbuild.build({
  entryPoints,
  outdir: 'out/test/integration',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', 'mocha'],
  logLevel: 'info',
});
