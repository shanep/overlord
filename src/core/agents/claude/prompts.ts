// The prompts a person typed to Claude Code, for Reputation: each main
// session transcript under ~/.claude/projects, and ~/.claude/history.jsonl,
// which keeps what was typed after the transcripts are cleaned up. Subagent
// transcripts are skipped, since a person never types into them.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { historyPrompts, transcriptPrompts } from '../../reputation/prompts.js';
import { peekSession } from '../../transcripts/peek.js';
import { readAllLines } from '../../transcripts/reader.js';
import { scanSessions } from '../../transcripts/scanner.js';
import type { PromptFile, PromptFileRead, UserPrompts } from '../types.js';

interface ClaudePromptPaths {
  readonly projectsDir: string;
  /** ~/.claude, which holds history.jsonl. */
  readonly configDir: string;
}

async function stampOf(file: string): Promise<PromptFile['stamp']> {
  try {
    const info = await stat(file);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

async function titleOf(file: string, size: number): Promise<string | null> {
  try {
    const peek = await peekSession(file, size);
    return peek.title;
  } catch {
    return null;
  }
}

async function read(file: PromptFile): Promise<PromptFileRead> {
  const lines = await readAllLines(file.path);
  if (file.kind === 'history' || file.sessionId === null) {
    return { prompts: historyPrompts(lines), title: null };
  }
  const prompts = transcriptPrompts(lines, {
    sessionId: file.sessionId,
    fallbackAt: file.stamp?.mtimeMs ?? 0,
  });
  return { prompts, title: await titleOf(file.path, file.stamp?.size ?? 0) };
}

export function claudeUserPrompts(paths: ClaudePromptPaths): UserPrompts {
  return {
    files: async (): Promise<PromptFile[]> => {
      const sessions = await scanSessions(paths.projectsDir);
      const historyFile = path.join(paths.configDir, 'history.jsonl');
      return [
        ...sessions.map((info): PromptFile => ({
          path: info.transcriptPath,
          stamp: { mtimeMs: info.mtimeMs, size: info.size },
          kind: 'transcript',
          sessionId: info.sessionId,
        })),
        { path: historyFile, stamp: await stampOf(historyFile), kind: 'history', sessionId: null },
      ];
    },
    read,
  };
}
