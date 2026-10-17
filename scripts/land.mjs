// Lands the session's branch on the default branch, one session at a time.
// Every push runs a check of about a minute, and when another session landed
// during that minute the push was turned away after its check had already
// run, sometimes four times in a row. This reviews the change first, then
// holds a machine-wide lock for the repository while it fetches, rebases,
// pushes (the pre-push hook runs the checks once) and confirms the commit is
// on the default branch, so no check runs for nothing.
//
// Usage: npm run land [-- --no-review] [-- --accept-review] [-- --dry-run]
// A dry run reviews and rebases but does not push.
// Exits 0 when landed or there is nothing to land, 1 when something failed
// (uncommitted work, a rebase conflict, a failed check), 2 when the review
// found a blocking problem.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { review } from './review.mjs';

const POLL_MS = 1000;
const ATTEMPTS = 5;
/** Git's own line for a ref the remote turned away, not words in the hook's output. */
const GIT_REJECTED = /^ ! \[(?:remote )?rejected\]/mu;
const flags = new Set(process.argv.slice(2));
const cwd = process.cwd();

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  };
}

function must(args) {
  const result = git(args);
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.err}`);
  }
  return result.out;
}

function say(text) {
  process.stderr.write(`land: ${text}\n`);
}

/** "master" or "main", from origin/HEAD, else whichever exists on origin. */
function defaultBranch() {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out.startsWith('origin/')) {
    return head.out.slice('origin/'.length);
  }
  for (const name of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]).ok) {
      return name;
    }
  }
  throw new Error('cannot tell the default branch. Run git remote set-head origin --auto.');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The lock file for this repository, shared by all of its worktrees. */
function lockPath() {
  const common = path.resolve(cwd, must(['rev-parse', '--git-common-dir']));
  const key = createHash('sha256').update(common).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), `overlord-land-${String(os.userInfo().uid)}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${key}.lock`);
}

function holderOf(lock) {
  try {
    return JSON.parse(readFileSync(lock, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Clears a lock whose holder died. Renaming it away is atomic, so when two
 * sessions both see the dead holder only one moves the file, and a lock a
 * live session took in between is put back.
 */
function takeBack(lock, deadPid) {
  const moved = `${lock}.${String(process.pid)}`;
  try {
    renameSync(lock, moved);
  } catch {
    return;
  }
  if (holderOf(moved)?.pid !== deadPid) {
    try {
      linkSync(moved, lock);
    } catch {
      // Someone else holds it now, and they keep it.
    }
  }
  rmSync(moved, { force: true });
}

/** Waits for the lock. A lock whose holder died is taken back. */
async function acquire(lock) {
  let told = false;
  for (;;) {
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, cwd, at: Date.now() }), {
        flag: 'wx',
      });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
    const holder = holderOf(lock);
    if (holder !== null && !alive(holder.pid)) {
      takeBack(lock, holder.pid);
      continue;
    }
    if (!told && holder !== null) {
      say(`waiting for another session to land (pid ${String(holder.pid)} in ${holder.cwd}).`);
      told = true;
    }
    await sleep(POLL_MS);
  }
}

function release(lock) {
  if (holderOf(lock)?.pid === process.pid) {
    rmSync(lock, { force: true });
  }
}

/** Pushes HEAD with the hooks running and the output shown. True when it went through. */
async function push(branch) {
  return new Promise((resolve) => {
    const child = spawn('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {
      cwd,
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on('exit', (code) => {
      resolve({
        ok: code === 0,
        raced: GIT_REJECTED.test(output),
      });
    });
  });
}

/** Rebases onto the default branch. False after a conflict, with the rebase undone. */
function rebase(branch) {
  const result = git(['rebase', `origin/${branch}`]);
  if (result.ok) {
    return true;
  }
  const files = git(['diff', '--name-only', '--diff-filter=U']).out;
  git(['rebase', '--abort']);
  say(
    `rebasing onto origin/${branch} hit a conflict in:\n${files}\nRun git rebase origin/${branch}, fix it, commit and land again.`,
  );
  return false;
}

async function land(lock, branch) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    must(['fetch', '--quiet', 'origin', branch]);
    if (!rebase(branch)) {
      return 1;
    }
    if (flags.has('--dry-run')) {
      say(`dry run: would push ${must(['rev-parse', '--short', 'HEAD'])} to ${branch}.`);
      return 0;
    }
    const result = await push(branch);
    if (result.ok) {
      must(['fetch', '--quiet', 'origin', branch]);
      if (git(['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]).ok) {
        say(`landed ${must(['rev-parse', '--short', 'HEAD'])} on ${branch}.`);
        return 0;
      }
      say(`the push went through but HEAD is not on origin/${branch}. Look before going on.`);
      return 1;
    }
    if (!result.raced) {
      say('the push failed. Fix what the check reported, commit and land again.');
      return 1;
    }
    // Someone pushed without the lock. Rebase on what they landed and try again.
    say(
      `origin/${branch} moved while pushing, trying again (${String(attempt)} of ${String(ATTEMPTS)}).`,
    );
  }
  say(
    `gave up after ${String(ATTEMPTS)} tries. Something keeps pushing to ${branch} without landing.`,
  );
  return 1;
}

async function main() {
  if (must(['status', '--porcelain']) !== '') {
    say('there is uncommitted work. Commit it (or set it aside) and land again.');
    return 1;
  }
  const branch = defaultBranch();
  must(['fetch', '--quiet', 'origin', branch]);
  if (git(['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]).ok) {
    say(`nothing to land: HEAD is already on origin/${branch}.`);
    return 0;
  }
  if (!flags.has('--no-review')) {
    const verdict = await review(`origin/${branch}`, cwd, { accept: flags.has('--accept-review') });
    if (verdict === 'block') {
      return 2;
    }
  }
  const lock = lockPath();
  // Let go of the lock on Ctrl-C, then stop the way the signal would have.
  const leave = (signal) => {
    release(lock);
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  };
  process.on('SIGINT', leave);
  process.on('SIGTERM', leave);
  await acquire(lock);
  try {
    return await land(lock, branch);
  } finally {
    release(lock);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  say(error.message);
  process.exitCode = 1;
}
