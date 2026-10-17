// Turns Codex's own shapes (usage, rate limit windows, commands, edits and
// exec scripts) into the shared model's.
// cspell:words rollouts

import type { FeedItem, TokenUsage, ToolCall } from '../../../shared/model.js';
import { plainText } from '../../../shared/plain-text.js';
import type { RateLimits } from '../../../shared/protocol.js';
import { preview } from '../../transcripts/text.js';

import type { CodexItem, CodexRateLimits, CodexRateWindow, CodexUsage } from './records.js';
import { partsText, TESTED_CODEX_VERSIONS } from './records.js';

export type RateLimitWindow = NonNullable<RateLimits['windows']>[number];

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

/** Codex counts cached input inside input. The shared model keeps them apart, like Claude's API does. */
export function toTokenUsage(usage: CodexUsage): TokenUsage {
  const cached = usage.cached_input_tokens + usage.cache_write_input_tokens;
  return {
    input: Math.max(0, usage.input_tokens - cached),
    output: usage.output_tokens,
    cacheRead: usage.cached_input_tokens,
    cacheCreation: usage.cache_write_input_tokens,
    thinking: usage.reasoning_output_tokens,
  };
}

function windowLabel(minutes: number | null): string {
  if (minutes === null || minutes <= 0) {
    return 'Limit';
  }
  if (minutes % MINUTES_PER_DAY === 0) {
    return `${String(minutes / MINUTES_PER_DAY)} day`;
  }
  if (minutes % MINUTES_PER_HOUR === 0) {
    return `${String(minutes / MINUTES_PER_HOUR)} hour`;
  }
  return `${String(minutes)} minute`;
}

function toWindow(window: CodexRateWindow): RateLimitWindow {
  return {
    label: windowLabel(window.window_minutes),
    usedPct: window.used_percent,
    // Codex writes epoch seconds.
    resetsAt: window.resets_at === null ? null : window.resets_at * 1000,
  };
}

/** Codex's primary and secondary windows, in that order, as the shared rate limit windows. */
export function rateLimitWindows(limits: CodexRateLimits): RateLimitWindow[] {
  return [limits.primary, limits.secondary].flatMap((window) =>
    window === null ? [] : [toWindow(window)],
  );
}

/** The script a shell wrapper runs, like `/bin/zsh -lc "cat notes.txt"`, else the argv joined. */
export function commandText(command: CodexItem['command']): string {
  if (command === null) {
    return '';
  }
  if (typeof command === 'string') {
    return command;
  }
  const [, flag, script] = command;
  if (command.length === 3 && (flag === '-lc' || flag === '-c') && script !== undefined) {
    return script;
  }
  return command.join(' ');
}

/** Codex 0.163.0 writes a command's folder as a file:// URL. */
function folderPath(cwd: string | null): string | null {
  if (cwd === null) {
    return null;
  }
  return cwd.startsWith('file://') ? decodeURI(cwd.slice('file://'.length)) : cwd;
}

/** A finished tool, before the accumulator gives it ids and times. */
export interface ToolOutcome {
  readonly name: string;
  readonly input: unknown;
  readonly ok: boolean;
  readonly result: string;
}

/** The command or edit a CommandExecution or FileChange item ran, or null for any other item. */
export function itemTool(item: CodexItem): ToolOutcome | null {
  if (item.type === 'CommandExecution') {
    return {
      name: 'exec_command',
      input: { command: commandText(item.command), cwd: folderPath(item.cwd) },
      ok: item.status === 'completed' && (item.exit_code ?? 0) === 0,
      result: item.aggregated_output ?? '',
    };
  }
  if (item.type === 'FileChange') {
    const changes = Object.entries(item.changes ?? {}).map(([file, change]) => ({
      path: file,
      kind: change.type,
      diff: change.unified_diff,
    }));
    return {
      name: 'apply_patch',
      input: { changes },
      ok: item.status === 'completed',
      result: `${item.stdout ?? ''}${item.stderr ?? ''}`.trim(),
    };
  }
  return null;
}

const REJECTED = 'rejected by user';

/**
 * An exec call that ran no command or edit, read from its JavaScript and its
 * output. A declined approval leaves only this: the call, and an output that
 * says the user rejected it.
 */
export function scriptTool(
  script: string,
  output: string | readonly { readonly text: string | null }[],
): ToolOutcome {
  const text = typeof output === 'string' ? output : partsText(output);
  const tool = /tools\.(?<name>\w+)\(/u.exec(script)?.groups?.['name'];
  const cmd = /\bcmd\s*:\s*"(?<cmd>(?:[^"\\]|\\.)*)"/u.exec(script)?.groups?.['cmd'];
  const rejected = text.includes(REJECTED);
  return {
    name: tool ?? (cmd === undefined ? 'exec' : 'exec_command'),
    input: cmd === undefined ? { script } : { command: cmd.replaceAll(/\\(.)/gu, '$1') },
    ok: !rejected && !text.startsWith('Script failed'),
    result: rejected ? 'Rejected by user' : text,
  };
}

/** Where and when a tool ran, next to what it did. */
export interface ToolRun extends ToolOutcome {
  readonly id: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** The tool call for the store, and its call and result for the feed. */
export function toolEvents(
  sessionId: string,
  tool: ToolRun,
  previewChars: number,
): { readonly call: ToolCall; readonly feed: readonly FeedItem[] } {
  const resultPreview = preview(plainText(tool.result), previewChars);
  const call: ToolCall = {
    id: tool.id,
    sessionId,
    agentId: sessionId,
    name: tool.name,
    input: tool.input,
    startedAt: tool.startedAt,
    endedAt: tool.endedAt,
    ok: tool.ok,
    resultPreview,
  };
  const feed: FeedItem[] = [
    { kind: 'tool_use', id: call.id, at: tool.startedAt, name: call.name, input: call.input },
    {
      kind: 'tool_result',
      id: `${call.id}:result`,
      at: tool.endedAt,
      toolUseId: call.id,
      ok: tool.ok,
      text: resultPreview,
    },
  ];
  return { call, feed };
}

/** The note a session from an unchecked Codex version gets in its feed. */
export function versionNote(version: string, at: number): FeedItem {
  const tested = TESTED_CODEX_VERSIONS.join(', ');
  return {
    kind: 'system',
    id: `version:${version}`,
    at,
    text: `Format not verified: Codex ${version} wrote this session, and Overlord has only checked rollouts from Codex ${tested}, so some details may be missing.`,
  };
}

/** What the accumulator knows about a session past its calls and tools. */
export interface SessionFields {
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  model: string | null;
  effort: string | null;
  approval: string | null;
  sandbox: string | null;
  contextWindow: number | null;
  title: string | null;
  lastPrompt: string | null;
  lastPromptAt: number | null;
  startedAt: number | null;
}

export function emptyFields(): SessionFields {
  return {
    cwd: null,
    gitBranch: null,
    version: null,
    model: null,
    effort: null,
    approval: null,
    sandbox: null,
    contextWindow: null,
    title: null,
    lastPrompt: null,
    lastPromptAt: null,
    startedAt: null,
  };
}
