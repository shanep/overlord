// Moving a running session into Overlord. The /overlord skill opens a
// vscode:// link for the current session, and Continue on a session that is
// still open in another terminal stops that copy first, so two processes never
// write to the same session. Each agent in play whose sessions Overlord can
// continue gets its own copy of the skill, written for how it runs skills.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { claudeSkills } from '../agents/claude/library.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { LiveProcess } from '../surfaces/live.js';

import { messageOf } from './errors.js';
import { libraryPlace, readersInPlay } from './library-scan.js';
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

/** The link the /overlord skill opens, up to the session id the skill adds. */
function transferLink(uriScheme: string): string {
  return `${uriScheme}://${EXTENSION_ID}${TRANSFER_PATH}?session=`;
}

/** Text of Claude Code's /overlord skill. uriScheme is vscode, or vscode-insiders and so on. */
export function transferSkillText(uriScheme: string): string {
  return claudeSkills.transfer?.text(transferLink(uriScheme)) ?? '';
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

interface TransferTarget {
  readonly name: string;
  readonly file: string;
  readonly text: string;
}

/** Every agent in play that has an /overlord skill, Claude Code first. */
async function transferTargets(
  rt: Runtime,
  uriScheme: string,
  registry?: AgentRegistry,
): Promise<TransferTarget[]> {
  const readers = await readersInPlay(rt, registry);
  const place = libraryPlace(rt, null, null);
  const link = transferLink(uriScheme);
  return readers.flatMap((reader): TransferTarget[] => {
    const transfer = reader.library.skills?.transfer;
    if (transfer === undefined) {
      return [];
    }
    const file = path.join(transfer.folder(place), SKILL_NAME, 'SKILL.md');
    return [{ name: reader.name, file, text: transfer.text(link) }];
  });
}

/** "a", "a and b", "a, b and c", with or in place of and when asked. */
function listed(items: readonly string[], word = 'and'): string {
  const last = items.at(-1) ?? '';
  return items.length <= 1 ? last : `${items.slice(0, -1).join(', ')} ${word} ${last}`;
}

/**
 * Writes the /overlord skill after asking: into ~/.claude/skills, and into
 * the user skill folder of every other agent in play whose sessions Overlord
 * can continue in a tab.
 */
export async function installTransferSkill(
  rt: Runtime,
  uriScheme: string,
  registry?: AgentRegistry,
): Promise<void> {
  const targets = await transferTargets(rt, uriScheme, registry);
  if (targets.length === 0) {
    return;
  }
  const agentNames = targets.map((target) => target.name);
  const yes = await rt.host.confirm(
    `Add the /overlord command to ${listed(agentNames)}? It writes ${listed(targets.map((target) => target.file))}.`,
    'Add /overlord',
  );
  if (!yes) {
    return;
  }
  try {
    for (const target of targets) {
      await mkdir(path.dirname(target.file), { recursive: true });
      await writeFile(target.file, target.text);
    }
    rt.host.showInfo(
      `Added /overlord. Type it in any ${listed(agentNames, 'or')} session to move it here.`,
    );
  } catch (error) {
    rt.host.showError(`Could not add /overlord: ${messageOf(error)}`);
  }
}
