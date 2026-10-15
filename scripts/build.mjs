// Build the extension host bundle, the hook script and the webview bundle.
import process from 'node:process';

import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const hostOptions = {
  ...shared,
  entryPoints: ['src/host/extension.ts'],
  outfile: 'dist/extension.cjs',
  external: ['vscode'],
};

const hookOptions = {
  ...shared,
  entryPoints: ['src/hook/main.ts'],
  outfile: 'dist/overlord-hook.cjs',
  banner: { js: '#!/usr/bin/env node' },
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(hostOptions), esbuild.context(hookOptions)]);
  await Promise.all(contexts.map(async (context) => context.watch()));
  await viteBuild({ configFile: 'webview/vite.config.ts', build: { watch: {} } });
} else {
  await Promise.all([esbuild.build(hostOptions), esbuild.build(hookOptions)]);
  await viteBuild({
    configFile: 'webview/vite.config.ts',
    mode: production ? 'production' : 'development',
  });
}
