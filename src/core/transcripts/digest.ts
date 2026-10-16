// A short account of a session from its transcript: what the user asked,
// the files it edited, the commits it made and pushed, and its last reply. Combining
// sessions hands these to a new session so it can pick up where they left off.

import type { ContentBlock, TranscriptRecord } from './schemas.js';
import { parseTranscriptLine } from './schemas.js';
import { resultText } from './text.js';

export interface TranscriptDigest {
  /** The user's /rename title, else Claude's generated one, else null. */
  readonly title: string | null;
  /** What the user typed, oldest first, without the wrappers Claude Code adds. */
  readonly prompts: readonly string[];
  /** Files changed with the Edit and Write tools. Edits made from the shell are not seen. */
  readonly files: readonly string[];
  /** "abc1234 Subject" for each commit git printed, oldest first. A quiet commit prints none. */
  readonly commits: readonly string[];
  /** "abc1234..def5678 HEAD -> master" for each push, which shows what landed. */
  readonly pushes: readonly string[];
  readonly lastReply: string | null;
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Claude Code's own messages in the user's turn, which the user never typed. */
const SKIPPED = [
  '<task-notification>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-stdout>',
  '<bash-stderr>',
  '[Request interrupted',
  'Caveat:',
  'This session is being continued',
];

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/u;
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/u;
const BASH_INPUT = /^<bash-input>([\s\S]*)<\/bash-input>$/u;
// git commit prints "[branch abc1234] Subject", or "[detached HEAD abc1234] Subject".
const COMMIT = /^\[[^\]]* ([\da-f]{7,40})\] (.+)$/u;
// git push prints "   abc1234..def5678  HEAD -> master" for each ref it moved.
const PUSH = /^\+?([\da-f]{7,40}\.{2,3}[\da-f]{7,40}) +(\S+ -> \S+)$/u;

/** A slash command as the user typed it, "/name args". */
function slashCommand(text: string): string | null {
  const name = (COMMAND_NAME.exec(text)?.[1] ?? '').trim();
  if (name === '') {
    return null;
  }
  const args = (COMMAND_ARGS.exec(text)?.[1] ?? '').trim();
  return args === '' ? name : `${name} ${args}`;
}

/** The text the user typed, or null for a message Claude Code wrote. */
export function promptText(raw: string): string | null {
  const text = raw.replaceAll(REMINDER, '').trim();
  if (text === '' || SKIPPED.some((prefix) => text.startsWith(prefix))) {
    return null;
  }
  if (text.includes('<command-name>')) {
    return slashCommand(text);
  }
  const bash = BASH_INPUT.exec(text)?.[1];
  return bash === undefined ? text : `! ${bash.trim()}`;
}

function blockTexts(content: string | readonly ContentBlock[]): string[] {
  if (typeof content === 'string') {
    return [content];
  }
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

/** A string field of a tool call's input, or null. */
function inputField(block: ContentBlock, field: string): string | null {
  if (block.type !== 'tool_use' || typeof block.input !== 'object' || block.input === null) {
    return null;
  }
  const value: unknown = field in block.input ? Reflect.get(block.input, field) : null;
  return typeof value === 'string' && value !== '' ? value : null;
}

function editedFile(block: ContentBlock): string | null {
  return block.type === 'tool_use' && EDIT_TOOLS.has(block.name)
    ? inputField(block, 'file_path')
    : null;
}

/** "first second" for each output line that matches a pattern with two groups. */
function pairsIn(text: string, pattern: RegExp): string[] {
  return text.split('\n').flatMap((line) => {
    const pair = pattern.exec(line.trim())?.slice(1).join(' ');
    return pair === undefined ? [] : [pair];
  });
}

class DigestBuilder {
  customTitle: string | null = null;
  aiTitle: string | null = null;
  lastReply: string | null = null;
  readonly prompts: string[] = [];
  readonly files = new Set<string>();
  readonly commits = new Map<string, string>();
  readonly pushes = new Set<string>();
  /** Shell commands by tool use id, so a result is only read for commits when git made it. */
  private readonly commands = new Map<string, string>();

  add(record: TranscriptRecord): void {
    if (record.type === 'custom-title') {
      this.customTitle = record.customTitle;
    } else if (record.type === 'ai-title') {
      this.aiTitle = record.aiTitle;
    } else if (record.type === 'user' && record.isSidechain !== true) {
      this.addUser(
        record.message.content,
        record.isMeta === true || record.isCompactSummary === true,
      );
    } else if (record.type === 'assistant' && record.isSidechain !== true) {
      this.addAssistant(record.message.content);
    }
  }

  private addUser(content: string | readonly ContentBlock[], meta: boolean): void {
    if (!meta) {
      for (const text of blockTexts(content)) {
        const prompt = promptText(text);
        if (prompt !== null) {
          this.prompts.push(prompt);
        }
      }
    }
    if (typeof content !== 'string') {
      for (const block of content) {
        this.addResult(block);
      }
    }
  }

  /** Commits and pushes in the output of a git command. */
  private addResult(block: ContentBlock): void {
    const command = block.type === 'tool_result' ? this.commands.get(block.tool_use_id) : undefined;
    if (block.type !== 'tool_result' || command === undefined) {
      return;
    }
    const output = resultText(block.content);
    for (const commit of pairsIn(output, COMMIT)) {
      this.commits.set(commit.split(' ', 1).join(''), commit);
    }
    for (const push of command.includes('git push') ? pairsIn(output, PUSH) : []) {
      this.pushes.add(push);
    }
  }

  private addAssistant(content: readonly ContentBlock[]): void {
    for (const block of content) {
      const file = editedFile(block);
      if (file !== null) {
        this.files.add(file);
      }
      const command = block.type === 'tool_use' ? inputField(block, 'command') : null;
      if (block.type === 'tool_use' && command?.includes('git ') === true) {
        this.commands.set(block.id, command);
      }
    }
    const reply = blockTexts(content).join('\n').trim();
    if (reply !== '') {
      this.lastReply = reply;
    }
  }

  build(): TranscriptDigest {
    return {
      title: this.customTitle ?? this.aiTitle,
      prompts: this.prompts,
      files: [...this.files],
      commits: [...this.commits.values()],
      pushes: [...this.pushes],
      lastReply: this.lastReply,
    };
  }
}

/** The digest of a transcript's main thread. Lines that do not parse are skipped. */
export function digestTranscript(lines: readonly string[]): TranscriptDigest {
  const builder = new DigestBuilder();
  for (const line of lines) {
    const record = parseTranscriptLine(line);
    if (record !== null) {
      builder.add(record);
    }
  }
  return builder.build();
}
