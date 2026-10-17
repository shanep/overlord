// cspell:ignore llms
// Regenerate the knob catalogs in src/core/knobs/catalogs/ from each agent's docs.
//
//   npm run catalog                  every agent
//   npm run catalog -- claude-code   one agent
//
// Each agent has a parser module under src/core/knobs/ (unit tested) and a
// fetch step here. This script bundles the parser with esbuild in memory,
// imports it, and only does the fetch and write glue, so it runs on any Node
// 22+ without a TS loader. To add an agent, add an entry to AGENTS with its
// parser, a fetch step that returns the parser's input, and the counts that
// prove the parse worked.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGS = path.join(ROOT, 'src/core/knobs/catalogs');
const DASHES = [String.fromCodePoint(0x20_13), String.fromCodePoint(0x20_14)];

/** @param {string} url */
async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${String(response.status)}`);
  }
  return response.text();
}

const CLAUDE_DOCS = 'https://code.claude.com/docs';
const CLAUDE_PAGES = ['settings-reference', 'settings', 'env-vars', 'cli-reference'];

/**
 * Fetch each Claude Code page that llms.txt lists. A page it does not list is
 * null, which buildCatalog accepts for settings-reference only.
 */
async function claudeCodeSources() {
  const index = await fetchText(`${CLAUDE_DOCS}/llms.txt`);
  const [settingsReference, settings, envVariables, cliReference] = await Promise.all(
    CLAUDE_PAGES.map(async (name) => {
      const url = `${CLAUDE_DOCS}/en/${name}.md`;
      return index.includes(url) ? fetchText(url) : null;
    }),
  );
  if (!settings || !envVariables || !cliReference) {
    throw new Error('llms.txt no longer lists settings, env-vars or cli-reference.');
  }
  return { settingsReference: settingsReference ?? null, settings, envVariables, cliReference };
}

/**
 * @typedef {{ kind: 'setting' | 'env' | 'flag' }} Knob
 * @typedef {{
 *   parser: string,
 *   sources: () => Promise<unknown>,
 *   build: (parser: Record<string, unknown>, sources: unknown) => readonly Knob[],
 *   minimum: Record<Knob['kind'], number>,
 * }} AgentCatalog
 */

/** @type {Record<string, AgentCatalog>} */
const AGENTS = {
  'claude-code': {
    parser: 'src/core/knobs/doc-parser.ts',
    sources: claudeCodeSources,
    build: (parser, sources) => {
      const typed = /** @type {typeof import('../src/core/knobs/doc-parser.ts')} */ (parser);
      return typed.buildCatalog(
        /** @type {import('../src/core/knobs/doc-parser.ts').ReferencePages} */ (sources),
      );
    },
    minimum: { setting: 100, env: 100, flag: 30 },
  },
};

/** @param {string} file */
async function importParser(file) {
  const bundle = await esbuild.build({
    entryPoints: [path.join(ROOT, file)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  const code = bundle.outputFiles[0]?.text ?? '';
  /** @type {Record<string, unknown>} */
  const parser = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  );
  return parser;
}

/**
 * @param {string} id
 * @param {AgentCatalog} agent
 */
async function generate(id, agent) {
  const [parser, sources] = await Promise.all([importParser(agent.parser), agent.sources()]);
  const catalog = agent.build(parser, sources);
  const counts = { setting: 0, env: 0, flag: 0 };
  for (const knob of catalog) {
    counts[knob.kind] += 1;
  }
  for (const [kind, minimum] of Object.entries(agent.minimum)) {
    const count = counts[/** @type {Knob['kind']} */ (kind)];
    if (count < minimum) {
      throw new Error(
        `${id}: only ${String(count)} ${kind} entries parsed, expected ${String(minimum)}+.`,
      );
    }
  }
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  if (DASHES.some((dash) => json.includes(dash))) {
    throw new Error(`${id}: the catalog still contains an em or en dash.`);
  }
  const output = path.join(CATALOGS, `${id}.json`);
  await writeFile(output, json, 'utf8');
  process.stdout.write(
    `Wrote ${String(catalog.length)} knobs (${String(counts.setting)} settings, ` +
      `${String(counts.env)} env vars, ${String(counts.flag)} flags) to ${path.relative(ROOT, output)}\n`,
  );
}

const wanted = process.argv.slice(2);
const unknown = wanted.filter((id) => !Object.hasOwn(AGENTS, id));
if (unknown.length > 0) {
  throw new Error(
    `No catalog source for ${unknown.join(', ')}. Known: ${Object.keys(AGENTS).join(', ')}.`,
  );
}
for (const id of wanted.length === 0 ? Object.keys(AGENTS) : wanted) {
  const agent = AGENTS[id];
  if (agent !== undefined) {
    await generate(id, agent);
  }
}
