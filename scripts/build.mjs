// Build the extension host bundle, the hook script and the webview bundle.
import { rmSync } from 'node:fs';
import process from 'node:process';

import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// Start clean so stale source maps from a dev build never end up in a package.
rmSync('dist', { recursive: true, force: true });

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

// The Agent SDK is ESM and calls createRequire(import.meta.url), which is
// undefined in a CommonJS bundle, so point it at the bundle file instead.
const hostOptions = {
  ...shared,
  entryPoints: ['src/host/extension.ts'],
  outfile: 'dist/extension.cjs',
  external: ['vscode'],
  banner: {
    js: "const __overlordImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: { 'import.meta.url': '__overlordImportMetaUrl' },
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
