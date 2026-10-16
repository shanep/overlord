// Package the committed Overlord, install it into VS Code and wait until a
// window has reloaded onto the new build. It builds HEAD in a temporary
// worktree, so uncommitted work (yours or another session's) never ships.
// Installed copies watch their own bundle and reload themselves, then write
// ~/.claude/overlord/loaded.json, which is what this waits for.
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
const marker = path.join(configDir, 'overlord', 'loaded.json');

function run(command, args, cwd = repo) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function loadedMtime() {
  try {
    return JSON.parse(readFileSync(marker, 'utf8')).bundleMtimeMs;
  } catch {
    return null;
  }
}

/** Polls the marker until a window reports the installed bundle, or the time runs out. */
async function waitForReload(installed) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (loadedMtime() === installed) {
      return true;
    }
    await sleep(POLL_MS);
  }
  return false;
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
if (await waitForReload(installed)) {
  process.stdout.write('Reloaded: a VS Code window is running the new build.\n');
} else {
  process.stderr.write(
    `Installed, but no window reloaded within ${(TIMEOUT_MS / 1000).toString()} seconds. ` +
      'A window running a build from before auto reload needs one Developer: Reload Window by hand.\n',
  );
  process.exitCode = 1;
}
