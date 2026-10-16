// Runs a command once one of a few machine-wide slots is free. Many sessions
// check their work on this machine at once, and a dozen type-aware lints and
// coverage runs together pushed the load past 150 on 10 cores, so every one of
// them crawled. Taking turns gets each one done sooner.
//
// OVERLORD_CHECK_SLOTS sets how many run at once (a third of the cores by
// default). A slot whose holder died is taken back, and a command started from
// inside a slot runs right away, so nesting cannot deadlock.
import { spawn } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const HELD = 'OVERLORD_CHECK_SLOT';
const POLL_MS = 500;
const dir = path.join(os.tmpdir(), `overlord-check-slots-${String(os.userInfo().uid)}`);
const slots =
  Number.parseInt(process.env.OVERLORD_CHECK_SLOTS ?? '', 10) ||
  Math.max(1, Math.floor(os.availableParallelism() / 3));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function holder(slot) {
  try {
    return Number.parseInt(readFileSync(slot, 'utf8'), 10);
  } catch {
    return null;
  }
}

// A slot is a hard link to the caller's ticket, which already holds its pid,
// so making one is atomic and a slot is never seen half written.
function tryTake(ticket) {
  const busy = [];
  for (let index = 0; index < slots; index += 1) {
    const slot = path.join(dir, `slot-${String(index)}`);
    const pid = holder(slot);
    if (pid !== null && !alive(pid)) {
      rmSync(slot, { force: true });
    }
    try {
      linkSync(ticket, slot);
      return { slot, busy };
    } catch {
      busy.push(holder(slot));
    }
  }
  return { slot: null, busy };
}

async function take() {
  mkdirSync(dir, { recursive: true });
  const ticket = path.join(dir, `ticket-${String(process.pid)}`);
  writeFileSync(ticket, String(process.pid));
  try {
    let told = false;
    for (;;) {
      const { slot, busy } = tryTake(ticket);
      if (slot !== null) {
        return slot;
      }
      if (!told) {
        process.stderr.write(
          `Waiting for a free check slot. Other sessions' checks hold all ${String(slots)} (pids ${busy.join(', ')}).\n`,
        );
        told = true;
      }
      await sleep(POLL_MS);
    }
  } finally {
    rmSync(ticket, { force: true });
  }
}

async function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, [HELD]: '1' } });
    const forward = (signal) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', (error) => {
      process.stderr.write(`${command}: ${error.message}\n`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write('Usage: node scripts/slot.mjs <command> [args...]\n');
  process.exitCode = 2;
} else if (process.env[HELD] === undefined) {
  const slot = await take();
  try {
    process.exitCode = await run(command, args);
  } finally {
    rmSync(slot, { force: true });
  }
} else {
  process.exitCode = await run(command, args);
}
