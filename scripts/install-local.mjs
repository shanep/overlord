// Package the committed Overlord, install it into VS Code and wait until a
// window has reloaded onto the new build. It builds HEAD in a temporary
// worktree, so uncommitted work (yours or another session's) never ships.
// It refuses a HEAD that is behind origin/master, since that build would drop
// whatever other sessions landed since the branch was cut, and a HEAD with
// commits that never landed, since the next install from master would drop
// them while the session that made them reports its work installed.
// Installed copies watch their own bundle and reload themselves, then write
// ~/.overlord/loaded.json, which is what this waits for. A window with
// Launcher runs going holds the reload until they finish and writes held.json
// instead, since a reload would end them. Builds from before the move wrote
// both markers under ~/.claude/overlord/, so that folder is checked second.
// Once reloaded, the new build builds every view from the real data on this
// machine and writes check.json, and this reports which views failed and what
// errors came up meanwhile.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const TIMEOUT_MS = 60_000;
const POLL_MS = 500;

const repo = process.cwd();
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const vsixName = `${manifest.name}-${manifest.version}.vsix`;
const extensionsDir =
  process.env.VSCODE_EXTENSIONS ?? path.join(os.homedir(), '.vscode', 'extensions');
const bundle = path.join(
  extensionsDir,
  `${manifest.publisher}.${manifest.name}-${manifest.version}`,
  'dist',
  'extension.cjs',
);
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const markerDirs = [path.join(os.homedir(), '.overlord'), path.join(configDir, 'overlord')];
/** The build waits a few seconds, then lets caches load for 20 before it measures. */
const CHECK_TIMEOUT_MS = 90_000;

function run(command, args, cwd = repo) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function readMarker(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The first marker with this name, in either folder, that names the installed bundle. */
function findMarker(name, installed) {
  for (const dir of markerDirs) {
    const found = readMarker(path.join(dir, name));
    if (found?.bundleMtimeMs === installed) {
      return found;
    }
  }
  return null;
}

/**
 * Polls the markers until a window reports the installed bundle, says it
 * holds the reload for Launcher runs, or the time runs out.
 */
async function waitForReload(installed) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (findMarker('loaded.json', installed) !== null) {
      return { reloaded: true, runs: 0 };
    }
    const held = findMarker('held.json', installed);
    if (held !== null) {
      return { reloaded: false, runs: held.runs };
    }
    await sleep(POLL_MS);
  }
  return { reloaded: false, runs: 0 };
}

function count(range) {
  return execFileSync('git', ['rev-list', '--count', range], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

/**
 * Stops when HEAD is missing commits from origin/master, or has commits it
 * lacks. A failed fetch falls back to the last origin/master this checkout
 * saw. --allow-behind and --allow-unlanded skip each half.
 */
function checkLanded() {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', 'master'], { cwd: repo, stdio: 'ignore' });
  } catch {
    process.stderr.write('Could not fetch origin/master, so checking against the last one seen.\n');
  }
  const behind = count('HEAD..origin/master');
  if (behind !== '0' && !process.argv.includes('--allow-behind')) {
    throw new Error(
      `HEAD is ${behind} commits behind origin/master, so this build would drop what landed since. ` +
        'Rebase first (git fetch origin master && git rebase origin/master) and install again, ' +
        'or pass --allow-behind to install this older build on purpose.',
    );
  }
  const unlanded = count('origin/master..HEAD');
  if (unlanded !== '0' && !process.argv.includes('--allow-unlanded')) {
    throw new Error(
      `HEAD has ${unlanded} commits that are not on origin/master, so the next install from master ` +
        'would drop them. Land them first (npm run land) and install again, ' +
        'or pass --allow-unlanded to try this build before landing it.',
    );
  }
}

checkLanded();

const tree = path.join(mkdtempSync(path.join(os.tmpdir(), 'overlord-install-')), 'tree');
run('git', ['worktree', 'add', '--detach', tree, 'HEAD']);
try {
  // Borrow the checkout's dependencies instead of a fresh npm ci.
  symlinkSync(path.join(repo, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
  run('npm', ['run', '-s', 'package'], tree);
  run('code', ['--install-extension', path.join(tree, vsixName), '--force']);
} finally {
  run('git', ['worktree', 'remove', '--force', tree]);
  rmSync(path.dirname(tree), { recursive: true, force: true });
}

/** Waits for the new build's self-check. Null when it did not come in time. */
async function waitForCheck(installed) {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const check = findMarker('check.json', installed);
    if (check !== null) {
      return check;
    }
    await sleep(POLL_MS);
  }
  return null;
}

/** Prints the self-check. True when every view built. */
function reportCheck(check) {
  const failed = check.views.filter((view) => !view.ok);
  const slow = check.views.filter((view) => view.ok && view.ms > 500);
  process.stdout.write(
    `Self-check: ${check.views.length.toString()} views built from real data, ${failed.length.toString()} failed.\n`,
  );
  for (const view of failed) {
    process.stderr.write(`  ${view.view} failed: ${view.error}\n`);
  }
  for (const view of slow) {
    process.stdout.write(
      `  ${view.view} is slow: ${Math.round(view.ms).toString()} ms to build.\n`,
    );
  }
  for (const error of check.errors) {
    process.stdout.write(`  ${error.source} reported: ${error.message}\n`);
  }
  process.stdout.write(`  Details in ${path.join(markerDirs[0], 'check.json')}.\n`);
  return failed.length === 0;
}

const installed = statSync(bundle).mtimeMs;
process.stdout.write(`Installed ${bundle}. Waiting for a VS Code window to reload onto it.\n`);
const result = await waitForReload(installed);
if (result.reloaded) {
  process.stdout.write('Reloaded: a VS Code window is running the new build.\n');
  const check = await waitForCheck(installed);
  if (check === null) {
    process.stderr.write('The new build did not write its self-check in time.\n');
    process.exitCode = 1;
  } else if (!reportCheck(check)) {
    process.exitCode = 1;
  }
} else if (result.runs > 0) {
  process.stdout.write(
    `Held: a VS Code window reloads onto the new build once its ${result.runs.toString()} ` +
      'Launcher runs finish, since a reload would end them.\n',
  );
} else {
  process.stderr.write(
    `Installed, but no window reloaded within ${(TIMEOUT_MS / 1000).toString()} seconds. ` +
      'A window running a build from before auto reload needs one Developer: Reload Window by hand.\n',
  );
  process.exitCode = 1;
}
