// Deploys the Reputation leaderboard Worker to Cloudflare. The first run
// creates the D1 database and writes its id into leaderboard/wrangler.toml.
// Every run applies new migrations, deploys, and writes the Worker's address
// into src/shared/leaderboard.ts so the extension calls it.
//
//   node scripts/deploy-leaderboard.mjs
//
// Needs a Cloudflare sign-in on this machine first: npx wrangler login

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'leaderboard');
const TOML = path.join(DIR, 'wrangler.toml');
const SHARED = path.join(ROOT, 'src', 'shared', 'leaderboard.ts');
const DATABASE = 'overlord-leaderboard';
const PLACEHOLDER = 'REPLACE_ON_FIRST_DEPLOY';
const WRANGLER = ['--yes', 'wrangler@4.147.0'];
/** One line to the terminal. */
function say(line) {
  process.stdout.write(`${line}\n`);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

/** Runs wrangler in the leaderboard folder, echoing its output, and returns it. */
function wrangler(args, { quiet = false } = {}) {
  const output = execFileSync('npx', [...WRANGLER, ...args], {
    cwd: DIR,
    encoding: 'utf8',
    // CI=true answers wrangler's "ok to proceed?" questions, so nothing waits on a keypress.
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'],
  });
  if (!quiet) {
    process.stdout.write(output);
  }
  return output;
}

function databaseId() {
  try {
    const found = UUID.exec(wrangler(['d1', 'info', DATABASE, '--json'], { quiet: true }));
    if (found !== null) {
      return found[0];
    }
  } catch {
    // Not created yet.
  }
  const created = UUID.exec(wrangler(['d1', 'create', DATABASE]));
  if (created === null) {
    throw new Error('wrangler did not print the new database id');
  }
  return created[0];
}

const toml = readFileSync(TOML, 'utf8');
if (toml.includes(PLACEHOLDER)) {
  const id = databaseId();
  writeFileSync(TOML, toml.replace(PLACEHOLDER, id));
  say(`Database ${DATABASE} is ${id}.`);
}

wrangler(['d1', 'migrations', 'apply', DATABASE, '--remote']);
const deployed = wrangler(['deploy']);
const url = /https:\/\/[\w.-]+\.workers\.dev/u.exec(deployed)?.[0];
if (url === undefined) {
  throw new Error('wrangler did not print the Worker address');
}
const shared = readFileSync(SHARED, 'utf8');
const next = shared.replace(
  /export const LEADERBOARD_URL = '[^']*';/u,
  `export const LEADERBOARD_URL = '${url}';`,
);
if (next !== shared) {
  writeFileSync(SHARED, next);
  say(`Wrote ${url} into src/shared/leaderboard.ts. Commit it so the extension uses it.`);
}
say(`The leaderboard is live at ${url}`);
