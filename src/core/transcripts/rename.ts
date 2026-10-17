// Names a session the way Claude Code's /resume renames a session it is not
// running: a custom-title record at the end of the transcript, where the last
// one wins, and a custom-title.json in the session's folder next to it.

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Where Claude Code keeps a session's name outside its transcript. */
export function titleSidecarPath(transcriptPath: string, sessionId: string): string {
  return path.join(path.dirname(transcriptPath), sessionId, 'custom-title.json');
}

export async function saveSessionTitle(
  transcriptPath: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const record = { type: 'custom-title', customTitle: title, sessionId };
  await appendFile(transcriptPath, `${JSON.stringify(record)}\n`);
  const sidecar = titleSidecarPath(transcriptPath, sessionId);
  await mkdir(path.dirname(sidecar), { recursive: true, mode: 0o700 });
  await writeFile(sidecar, JSON.stringify({ customTitle: title }), { mode: 0o600 });
}
