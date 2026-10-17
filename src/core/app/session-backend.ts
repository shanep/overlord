// Which backend a session ran on, so Continue resumes it on the same one.
// Claude Code records each reply's model in the transcript, and replies that
// came through the boisestate.ai bridge carry the backend's own model ids,
// such as global.anthropic.claude-opus-5-5. So nothing has to be stored when
// a session starts, and sessions from before this still resume right.

import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';

import { backendOf } from '../../shared/backends.js';
import type { ClaudePaths } from '../paths.js';
import { transcriptPathFor } from '../surfaces/desktop.js';

/** The last replies sit near the end, after any long tool output. */
const TAIL_BYTES = 1024 * 1024;
// Claude Code writes this model on the error notes it adds itself.
const SYNTHETIC = '<synthetic>';

function modelOf(line: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // The tail can start partway through a line.
    return null;
  }
  if (value === null || typeof value !== 'object' || !('message' in value)) {
    return null;
  }
  const message: unknown = value.message;
  if (message === null || typeof message !== 'object' || !('model' in message)) {
    return null;
  }
  return typeof message.model === 'string' && message.model !== SYNTHETIC ? message.model : null;
}

/** The model of the last real reply in some transcript text, or null when it has none. */
export function lastModel(text: string): string | null {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const model = line.includes('"assistant"') ? modelOf(line) : null;
    if (model !== null) {
      return model;
    }
  }
  return null;
}

async function readTail(file: string, bytes: number): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** True when the session's last reply came through the boisestate.ai bridge. */
export async function ranOnBridge(
  paths: ClaudePaths,
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  const tail = await readTail(transcriptPathFor(paths, cwd, sessionId), TAIL_BYTES);
  const model = tail === null ? null : lastModel(tail);
  return backendOf(model) === 'boisestate';
}
