// Moving a running Claude Code session into Overlord. The /overlord skill opens
// a vscode:// link for the current session, and Continue on a session that is
// still open in another terminal stops that copy first, so two processes never
// write to the same session.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { LiveProcess } from '../surfaces/live.js';

import { messageOf } from './errors.js';
import type { Runtime } from './runtime.js';

export const EXTENSION_ID = 'shanep.overlord';
export const TRANSFER_PATH = '/continue';
export const SKILL_NAME = 'overlord';
/** How long to wait for the other terminal's claude to exit after SIGTERM. */
export const EXIT_WAIT_MS = 15_000;
const POLL_MS = 250;
const SESSION_ID = /^[\w-]{1,128}$/u;

/** The session id from a vscode://shanep.overlord/continue?session=<id> link, or null. */
export function parseTransferUri(uriPath: string, query: string): string | null {
  if (uriPath !== TRANSFER_PATH) {
    return null;
  }
  const id = new URLSearchParams(query).get('session');
  return id !== null && SESSION_ID.test(id) ? id : null;
}

/** Text of the /overlord skill. uriScheme is vscode, or vscode-insiders and so on. */
export function transferSkillText(uriScheme: string): string {
  const link = `${uriScheme}://${EXTENSION_ID}${TRANSFER_PATH}?session=\${CLAUDE_SESSION_ID}`;
  return `---
name: ${SKILL_NAME}
description: Move this Claude Code session into Overlord in VS Code, where it continues in an editor tab.
disable-model-invocation: true
---

!\`code --open-url "${link}" 2>/dev/null || open "${link}" 2>/dev/null || xdg-open "${link}"\`

Overlord is taking over this session in VS Code, and will stop this terminal's copy once you
confirm there. Reply with one short line saying the session is moving to VS Code. Do nothing else.
`;
}

export function transferSkillPath(rt: Pick<Runtime, 'paths'>): string {
  return path.join(rt.paths.userSkillsDir, SKILL_NAME, 'SKILL.md');
}

async function waitForExit(rt: Runtime, pid: number): Promise<boolean> {
  for (let waited = 0; waited < EXIT_WAIT_MS; waited += POLL_MS) {
    if (!rt.isAlive(pid)) {
      return true;
    }
    await rt.delay(POLL_MS);
  }
  return !rt.isAlive(pid);
}

/**
 * Makes sure no other claude process holds the session before Overlord
 * resumes it. True when it is safe to continue.
 */
export async function clearOtherCopy(
  rt: Runtime,
  live: LiveProcess | undefined,
  title: string,
): Promise<boolean> {
  if (live === undefined || live.pid === null || !live.alive) {
    return true;
  }
  const { pid } = live;
  const moved = await rt.host.confirm(
    `"${title}" is still open in another terminal (pid ${String(pid)}). Stop it there and continue it here?`,
    'Move here',
  );
  if (!moved) {
    return false;
  }
  rt.kill(pid, 'SIGTERM');
  if (await waitForExit(rt, pid)) {
    return true;
  }
  rt.host.showWarning(
    `Claude (pid ${String(pid)}) did not exit, so Overlord did not continue it. Close that terminal and try again.`,
  );
  return false;
}

/** Writes the /overlord skill into ~/.claude/skills after asking. */
export async function installTransferSkill(rt: Runtime, uriScheme: string): Promise<void> {
  const file = transferSkillPath(rt);
  const yes = await rt.host.confirm(
    `Add the /overlord command to Claude Code? It writes ${file}.`,
    'Add /overlord',
  );
  if (!yes) {
    return;
  }
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, transferSkillText(uriScheme));
    rt.host.showInfo('Added /overlord. Type it in any Claude Code session to move it here.');
  } catch (error) {
    rt.host.showError(`Could not add /overlord: ${messageOf(error)}`);
  }
}
