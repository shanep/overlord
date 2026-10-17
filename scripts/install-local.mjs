// Package the committed Overlord, install it into VS Code and wait until a
// window has reloaded onto the new build. It builds HEAD in a temporary
// worktree, so uncommitted work (yours or another session's) never ships.
// Installed copies watch their own bundle and reload themselves, then write
// ~/.overlord/loaded.json, which is what this waits for. A window with
// Launcher runs going holds the reload until they finish and writes held.json
// instead, since a reload would end them. Builds from before the move wrote
// both markers under ~/.claude/overlord/, so that folder is checked second.
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

const installed = statSync(bundle).mtimeMs;
process.stdout.write(`Installed ${bundle}. Waiting for a VS Code window to reload onto it.\n`);
const result = await waitForReload(installed);
if (result.reloaded) {
  process.stdout.write('Reloaded: a VS Code window is running the new build.\n');
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
