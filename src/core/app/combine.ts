// Combining sessions. Claude Code cannot join two conversations, so Overlord
// starts one new session whose first message is a digest of the others: what
// the user asked, what each one changed and where it left off. Then it offers
// to stop the ones still running.

import type { SessionSummary } from '../../shared/model.js';
import type { FleetState } from '../../shared/protocol.js';
import type { TranscriptDigest } from '../transcripts/digest.js';
import { digestTranscript } from '../transcripts/digest.js';
import { preview } from '../transcripts/text.js';

import type { ActionHandlers } from './action-types.js';
import { stopNow } from './actions-session.js';
import type { PickItem } from './host-port.js';
import type { Runtime } from './runtime.js';
import { fleetFor } from './views/fleet.js';
import { startSession } from './worktrees.js';

export interface CombineSource {
  readonly session: SessionSummary;
  readonly digest: TranscriptDigest;
}

/**
 * The whole prompt goes on claude's command line, and Linux caps one argument
 * at 128 KiB, so the digest stays well under that.
 */
export const PROMPT_LIMIT = 60_000;
const PROMPT_CHARS = 500;
const SHOWN_PROMPTS = 20;
const FIRST_PROMPTS = 5;
const REPLY_CHARS = 3000;
const LIST_ITEMS = 40;
export const CUT_NOTE = '\n\n(Cut to fit. The transcripts have the rest.)';
export const TAB_NAME = 'Combined session';

function oneLine(text: string, max: number): string {
  return preview(text.replaceAll(/\s+/gu, ' ').trim(), max);
}

function titleOf(source: CombineSource): string {
  const { session, digest } = source;
  return digest.title ?? (session.title === '' ? session.id : session.title);
}

/** The first few prompts and the latest ones, since the middle matters least. */
function promptLines(prompts: readonly string[]): string[] {
  const numbered = prompts.map(
    (text, index) => `${String(index + 1)}. ${oneLine(text, PROMPT_CHARS)}`,
  );
  if (numbered.length <= SHOWN_PROMPTS) {
    return numbered;
  }
  const hidden = numbered.length - SHOWN_PROMPTS;
  return [
    ...numbered.slice(0, FIRST_PROMPTS),
    `(${String(hidden)} more not shown)`,
    ...numbered.slice(FIRST_PROMPTS + hidden),
  ];
}

function listSection(heading: string, items: readonly string[]): string[] {
  if (items.length === 0) {
    return [];
  }
  const shown = items.slice(0, LIST_ITEMS).map((item) => `- ${item}`);
  const more = items.length > LIST_ITEMS ? [`- (${String(items.length - LIST_ITEMS)} more)`] : [];
  return [`### ${heading}`, ...shown, ...more, ''];
}

function sourceSection(source: CombineSource, index: number): string[] {
  const { session, digest } = source;
  const facts = [
    `- Session id: ${session.id}`,
    `- Folder: ${session.cwd}`,
    ...(session.gitBranch === null ? [] : [`- Branch: ${session.gitBranch}`]),
    `- State: ${session.state}`,
    ...(session.transcriptPath === null ? [] : [`- Transcript: ${session.transcriptPath}`]),
  ];
  const asked = digest.prompts.length === 0 ? ['(none found)'] : promptLines(digest.prompts);
  return [
    `## Session ${String(index + 1)}: ${titleOf(source)}`,
    ...facts,
    '',
    '### What I asked',
    ...asked,
    '',
    ...listSection('Commits', digest.commits),
    ...listSection('Pushes', digest.pushes),
    ...listSection('Files edited with the Edit and Write tools', digest.files),
    '### Its last reply',
    digest.lastReply === null ? '(none)' : preview(digest.lastReply, REPLY_CHARS),
    '',
  ];
}

/** The new session's first message: what to do, then one section per session, oldest first. */
export function combinePrompt(sources: readonly CombineSource[]): string {
  const intro =
    `This session picks up from ${String(sources.length)} earlier Claude Code sessions that I combined in Overlord. ` +
    'Below is what I asked each one, what it changed and where it left off. Read it, check the ' +
    'current state of the code (git log and git status are a good start), then give me a short ' +
    'summary of where things stand and wait for what I want next. Each full transcript is ' +
    'listed if you need more.';
  const text = [intro, '', ...sources.flatMap((source, index) => sourceSection(source, index))]
    .join('\n')
    .trim();
  return text.length > PROMPT_LIMIT
    ? `${text.slice(0, PROMPT_LIMIT - CUT_NOTE.length)}${CUT_NOTE}`
    : text;
}

/** A session Overlord can read the transcript of. */
interface Transcribed extends SessionSummary {
  readonly transcriptPath: string;
}

function hasTranscript(session: SessionSummary): session is Transcribed {
  return session.transcriptPath !== null;
}

function isActive(session: SessionSummary): boolean {
  return session.state !== 'done' && session.state !== 'failed';
}

function projectName(fleet: FleetState, sessionId: string): string {
  const projectId = fleet.sessionProjects[sessionId]?.projectId ?? null;
  return fleet.projects.find((item) => item.id === projectId)?.name ?? 'No project';
}

/** Every other session with a transcript: the anchor's project first, then the most recent. */
function candidates(fleet: FleetState, anchor: SessionSummary): Transcribed[] {
  const project = fleet.sessionProjects[anchor.id]?.projectId ?? null;
  const sameProject = (session: SessionSummary): number =>
    Number((fleet.sessionProjects[session.id]?.projectId ?? null) !== project);
  return fleet.sessions
    .filter((session): session is Transcribed => hasTranscript(session) && session.id !== anchor.id)
    .toSorted(
      (left, right) => sameProject(left) - sameProject(right) || right.updatedAt - left.updatedAt,
    );
}

function pickItem(fleet: FleetState, session: SessionSummary): PickItem {
  return {
    id: session.id,
    label: session.title === '' ? session.cwd : session.title,
    description: `${projectName(fleet, session.id)} · ${session.state}`,
  };
}

/** The session and its digest. A transcript that has since gone gives an empty one. */
async function readSource(rt: Runtime, session: Transcribed): Promise<CombineSource> {
  const text = await rt.fs.readFile(session.transcriptPath);
  return { session, digest: digestTranscript(text?.split('\n') ?? []) };
}

/** The anchor's project folder, else its own folder, else the workspace when both are gone. */
async function startFolder(rt: Runtime, anchor: SessionSummary): Promise<string | null> {
  const folder = rt.projects.resolve(anchor.cwd)?.folder ?? anchor.cwd;
  return (await rt.fs.kind(folder)) === 'directory' ? folder : rt.host.workspaceFolder();
}

async function offerStop(rt: Runtime, combined: readonly SessionSummary[]): Promise<void> {
  const running = combined.filter((session) => isActive(session));
  const [only] = running;
  if (only === undefined) {
    return;
  }
  const question =
    running.length === 1
      ? `Stop "${only.title}"? The new session starts from its digest, and its transcript stays.`
      : `Stop the ${String(running.length)} combined sessions that are still running? The new session starts from their digest, and their transcripts stay.`;
  if (!(await rt.host.confirm(question, 'Stop'))) {
    return;
  }
  const stopped = await Promise.all(running.map(async (session) => stopNow(rt, session.id)));
  const missed = stopped.filter((ok) => !ok).length;
  if (missed > 0) {
    rt.host.showInfo(
      `${String(missed)} of them ${missed === 1 ? 'is' : 'are'} not running on this machine, so Overlord left ${missed === 1 ? 'it' : 'them'} alone.`,
    );
  }
}

async function combine(rt: Runtime, sessionId: string): Promise<void> {
  const fleet = fleetFor(rt);
  const anchor = fleet.sessions.find((session) => session.id === sessionId);
  if (anchor === undefined || !hasTranscript(anchor)) {
    rt.host.showInfo('Overlord has no transcript for that session, so it cannot combine it.');
    return;
  }
  const others = candidates(fleet, anchor);
  if (others.length === 0) {
    rt.host.showInfo('There is no other session with a transcript to combine it with.');
    return;
  }
  const label = anchor.title === '' ? 'this session' : `"${anchor.title}"`;
  const picked = await rt.host.quickPickMany(
    others.map((session) => pickItem(fleet, session)),
    `Combine ${label} with`,
  );
  if (picked === null || picked.length === 0) {
    return;
  }
  const chosen = [anchor, ...others.filter((session) => picked.includes(session.id))].toSorted(
    (left, right) => left.startedAt - right.startedAt,
  );
  const sources = await Promise.all(chosen.map(async (session) => readSource(rt, session)));
  await startSession(rt, await startFolder(rt, anchor), {
    name: TAB_NAME,
    prompt: combinePrompt(sources),
  });
  await offerStop(rt, chosen);
}

export const combineActions: ActionHandlers<'combineSessions'> = {
  combineSessions: async ({ rt }, action) => combine(rt, action.sessionId),
};
