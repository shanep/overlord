// The words Overlord puts in front of a session about the others in its
// repository. They go into the model's context, so they are short, concrete
// and say what to do.

import type { Workspace } from './workspaces.js';

const MAX_FILES = 8;
const MAX_PEERS = 8;
const MAX_TOPIC = 80;

/** The first line of a prompt, cut to a length that fits a list item. */
export function topicOf(text: string): string | null {
  const line = text.trim().split('\n', 1)[0]?.replaceAll(/\s+/gu, ' ').trim() ?? '';
  if (line === '') {
    return null;
  }
  return line.length > MAX_TOPIC ? `${line.slice(0, MAX_TOPIC - 3).trimEnd()}...` : line;
}

/** Files as "a, b and 3 more". */
export function fileList(files: readonly string[]): string {
  const shown = files.slice(0, MAX_FILES).join(', ');
  const rest = files.length - MAX_FILES;
  return rest > 0 ? `${shown} and ${String(rest)} more` : shown;
}

function who(peer: Workspace): string {
  if (peer.sessions.length === 0) {
    return peer.inUse ? 'A session' : `Unlanded work "${peer.label}" with no session open`;
  }
  return peer.sessions
    .map((session) => {
      const name = session.topic === null ? 'A session' : `"${session.topic}"`;
      return session.status === null ? name : `${name} (${session.status})`;
    })
    .join(', ');
}

/** One list line for another workspace. */
function describePeer(peer: Workspace, files: readonly string[] = peer.files): string {
  const where = peer.branch === null ? peer.root : `branch ${peer.branch}`;
  const changes = files.length === 0 ? 'no changes yet' : `changing ${fileList(files)}`;
  return `- ${who(peer)} in ${where}, ${changes}`;
}

function peerLines(peers: readonly Workspace[]): string[] {
  const lines = peers.slice(0, MAX_PEERS).map((peer) => describePeer(peer));
  const rest = peers.length - MAX_PEERS;
  return rest > 0 ? [...lines, `- and ${String(rest)} more`] : lines;
}

/** Who else works in the repository and what they are changing. */
export function peerContext(peers: readonly Workspace[]): string {
  return [
    'Overlord: other Claude Code sessions are working in this repository right now, each in its own worktree. Their changes have not landed on the default branch yet, so if you change the same files, whoever lands second hits a merge conflict.',
    ...peerLines(peers),
    'Stay out of the files they are changing when your task allows it, and keep any change to them small. Overlord pauses your first edit to a file another session is changing.',
  ].join('\n');
}

/** Why an edit was paused, and how to go ahead anyway. */
export function editWarning(file: string, peers: readonly Workspace[]): string {
  return [
    `Overlord paused this edit once. Another session in this repository is also changing ${file} and has not landed it yet, so whoever lands second hits a merge conflict:`,
    ...peers.map((peer) => describePeer(peer, [file])),
    `If your task needs this change, make the same edit again and it will go through. Otherwise leave ${file} to the other session.`,
  ].join('\n');
}

/** New commits on the target touch files this worktree changed too. */
export function landingNotice(target: string, files: readonly string[]): string {
  return [
    `Overlord: new commits landed on ${target} that change files you have also changed here: ${fileList(files)}.`,
    `Rebase onto it soon so the conflict stays small: commit your work in progress, run git fetch origin ${target} && git rebase origin/${target}, then check that your changes still fit the new code.`,
  ].join('\n');
}
