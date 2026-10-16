// cspell:ignore llms
// Regenerate src/core/knobs/catalog.generated.json from the Claude Code docs.
//
//   npm run catalog
//
// The parsing logic lives in src/core/knobs/doc-parser.ts (unit tested). This
// script bundles that module with esbuild in memory, imports it, and only does
// the fetch and write glue, so it runs on any Node 22+ without a TS loader.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARSER = path.join(ROOT, 'src/core/knobs/doc-parser.ts');
const OUTPUT = path.join(ROOT, 'src/core/knobs/catalog.generated.json');
const DOCS = 'https://code.claude.com/docs';
const PAGES = ['settings-reference', 'settings', 'env-vars', 'cli-reference'];
const MINIMUM = { setting: 100, env: 100, flag: 30 };
const DASHES = [String.fromCodePoint(0x20_13), String.fromCodePoint(0x20_14)];

const bundle = await esbuild.build({
  entryPoints: [PARSER],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
});
const code = bundle.outputFiles[0]?.text ?? '';
/** @type {typeof import('../src/core/knobs/doc-parser.ts')} */
const parser = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const [index = ''] = await Promise.all(
  [`${DOCS}/llms.txt`].map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GET ${url} failed with HTTP ${String(response.status)}`);
    }
    return response.text();
  }),
);

// Fetch each page that llms.txt lists. A page it does not list is null, which
// buildCatalog accepts for settings-reference only.
const [settingsReference, settings, envVariables, cliReference] = await Promise.all(
  PAGES.map(async (name) => {
    const url = `${DOCS}/en/${name}.md`;
    if (!index.includes(url)) {
      return null;
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GET ${url} failed with HTTP ${String(response.status)}`);
    }
    return response.text();
  }),
);
if (!settings || !envVariables || !cliReference) {
  throw new Error('llms.txt no longer lists settings, env-vars or cli-reference.');
}

const catalog = parser.buildCatalog({
  settingsReference: settingsReference ?? null,
  settings,
  envVariables,
  cliReference,
});

const counts = { setting: 0, env: 0, flag: 0 };
for (const knob of catalog) {
  counts[knob.kind] += 1;
}
for (const [kind, minimum] of Object.entries(MINIMUM)) {
  if (counts[kind] < minimum) {
    throw new Error(
      `Only ${String(counts[kind])} ${kind} entries parsed, expected ${String(minimum)}+.`,
    );
  }
}

const json = `${JSON.stringify(catalog, null, 2)}\n`;
if (DASHES.some((dash) => json.includes(dash))) {
  throw new Error('The catalog still contains an em or en dash.');
}
await writeFile(OUTPUT, json, 'utf8');
process.stdout.write(
  `Wrote ${String(catalog.length)} knobs (${String(counts.setting)} settings, ` +
    `${String(counts.env)} env vars, ${String(counts.flag)} flags) to ${path.relative(ROOT, OUTPUT)}\n`,
);
