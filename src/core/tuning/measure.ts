// Measures one session's transcript for the Tuning view: how big its context
// got, where the money went, and the habits that waste tokens (huge tool
// results, rereads, re-running the same command, denied tools). Only counts
// and short labels are kept, never prompt or file text.
// cspell:words uvicorn pytest

import { isPlainObject } from '../knobs/json.js';
import { transcriptPrompts } from '../reputation/prompts.js';
import type { PriceTable } from '../transcripts/pricing.js';
import { DEFAULT_PRICES, findPrice } from '../transcripts/pricing.js';
import type { ContentBlock, TranscriptRecord } from '../transcripts/schemas.js';
import { parseTimestamp, parseTranscriptLine } from '../transcripts/schemas.js';
import { resultText } from '../transcripts/text.js';

import type { SpendHour } from './spend-hours.js';
import { HourTally, isPremium } from './spend-hours.js';

/** US dollars at list price, split by token kind. */
export interface CostSplit {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Kinds of shell work that a skill or agent could take over. */
export type CommandFamily = 'land' | 'ci' | 'server' | 'buildTest' | 'search';

export interface RepeatedCommand {
  readonly command: string;
  readonly runs: number;
}

export interface SessionMeasure {
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string | null;
  /** Epoch ms of the first record. */
  readonly startedAt: number;
  /** Epoch ms of the last record. */
  readonly updatedAt: number;
  readonly prompts: number;
  /** API requests on the main thread. */
  readonly requests: number;
  /** Largest context sent in one main thread request, in tokens. */
  readonly peakContext: number;
  /** Context tokens summed over every main thread request. */
  readonly contextTokens: number;
  readonly compactions: number;
  /** Main thread cost. */
  readonly cost: CostSplit;
  /** Requests that wrote most of a large context again after a long pause. */
  readonly idleRewrites: number;
  readonly idleRewriteUsd: number;
  /** Tool results over BIG_RESULT_CHARS characters. */
  readonly bigResults: number;
  /** Reads of a file after its second read. */
  readonly extraReads: number;
  /** Runs of a shell command after its second identical run. */
  readonly repeatedRuns: number;
  readonly topRepeat: RepeatedCommand | null;
  readonly toolCalls: number;
  /** Failed tool calls, denials included. */
  readonly toolErrors: number;
  /** Tool calls the person or auto mode refused. */
  readonly denials: number;
  readonly bashCommands: number;
  /** Shell commands that start with cd. */
  readonly cdCommands: number;
  /** Subagents spawned, by agent type. */
  readonly spawns: Readonly<Record<string, number>>;
  readonly subagentRequests: number;
  /** Subagent requests on Opus, Fable or Mythos. */
  readonly premiumSubagentRequests: number;
  readonly subagentUsd: number;
  /** Main thread commands and searches by family. */
  readonly families: Readonly<Record<CommandFamily, number>>;
  /** Spend by clock hour, oldest first, for the plan limit windows. */
  readonly hours: readonly SpendHour[];
}

export interface MeasureInput {
  readonly sessionId: string;
  readonly main: readonly string[];
  /** One list of lines per subagent transcript. */
  readonly subagents: readonly (readonly string[])[];
  /** Used when no record has a valid timestamp. */
  readonly fallbackAt: number;
  readonly prices?: PriceTable;
}

/** About 10K tokens: big enough that leaving it in context for the rest of a session hurts. */
export const BIG_RESULT_CHARS = 40_000;
/** The shortest prompt cache lifetime. A large write after a longer pause is a rewrite. */
export const IDLE_GAP_MS = 5 * 60_000;
const IDLE_REWRITE_MIN_TOKENS = 50_000;
const TITLE_CHARS = 80;
const COMMAND_CHARS = 120;

const DENIAL =
  /doesn't want to proceed|denied by (?:the )?(?:Claude Code )?auto[- ]mode|permission to use \S+ (?:has been|was) denied/iu;
const CD_FIRST = /^\s*cd\s/u;

// Simple patterns, several per family, so each stays easy to read and check.
const FAMILY_PATTERNS: readonly (readonly [CommandFamily, readonly RegExp[]])[] = [
  ['land', [/\bgit\b[^|;&]*\s(?:fetch|rebase|push)\b/u]],
  ['ci', [/\bgh\s+run\b/u, /\bgh\s+pr\s+checks\b/u]],
  [
    'server',
    [
      /\blsof\s+-ti\b/u,
      /\bdotnet\s+(?:run|watch)\b/u,
      /\bnpm\s+(?:dev|start)\b/u,
      /\bnpm\s+run\s+(?:dev|start)\b/u,
      /\b(?:uvicorn|pkill)\b/u,
      /\bflask\s+run\b/u,
    ],
  ],
  [
    'buildTest',
    [
      /\bnpm\s+test\b/u,
      /\bnpm\s+run\s+(?:test|build|check)\b/u,
      /\bnpx\s+(?:vitest|jest|tsc)\b/u,
      /\b(?:dotnet|cargo|go)\s+(?:build|test)\b/u,
      /\b(?:pytest|make|mvn|gradle)\b/u,
    ],
  ],
  ['search', [/^\s*(?:grep|rg|find|cat|head|tail|ls)\b/u, /^\s*sed\s+-n\b/u]],
];

const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);
const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

const ZERO_COST: CostSplit = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function costTotal(cost: CostSplit): number {
  return cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
}

function addCost(left: CostSplit, right: CostSplit): CostSplit {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  };
}

function oneLine(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function stringField(input: unknown, key: string): string | null {
  const value = isPlainObject(input) ? input[key] : null;
  return typeof value === 'string' ? value : null;
}

function resultChars(block: Extract<ContentBlock, { type: 'tool_result' }>): number {
  const { content } = block;
  if (typeof content === 'string') {
    return content.length;
  }
  return content.reduce((sum, part) => sum + (part.text?.length ?? 0), 0);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Counts beyond `free` per key, summed: 5 reads of one file with free 2 gives 3. */
function beyond(map: ReadonlyMap<string, number>, free: number): number {
  let extra = 0;
  for (const count of map.values()) {
    extra += Math.max(0, count - free);
  }
  return extra;
}

interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

function costOfUsage(model: string, usage: Usage, prices: PriceTable): CostSplit | null {
  const price = findPrice(model, prices);
  if (price === null) {
    return null;
  }
  return {
    input: (usage.input * price.input) / 1_000_000,
    output: (usage.output * price.output) / 1_000_000,
    cacheRead: (usage.cacheRead * price.cacheRead) / 1_000_000,
    cacheWrite: (usage.cacheWrite * price.cacheWrite) / 1_000_000,
  };
}

type AssistantRecord = Extract<TranscriptRecord, { type: 'assistant' }>;
type BaseRecord = Extract<
  TranscriptRecord,
  { type: 'user' | 'assistant' | 'system' | 'attachment' }
>;

const BASE_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'attachment']);

function hasBaseFields(record: TranscriptRecord): record is BaseRecord {
  return BASE_TYPES.has(record.type);
}

/** The usage of a request the first time its message id shows up, or null for repeats. */
function firstUsage(record: AssistantRecord, seen: Set<string>): Usage | null {
  const { message } = record;
  if (seen.has(message.id) || message.usage === null || message.usage === undefined) {
    return null;
  }
  seen.add(message.id);
  return {
    input: message.usage.input_tokens,
    output: message.usage.output_tokens,
    cacheRead: message.usage.cache_read_input_tokens,
    cacheWrite: message.usage.cache_creation_input_tokens,
  };
}

/** Running totals for the main thread, mutated record by record. */
class MainTally {
  title: string | null = null;
  cwd: string | null = null;
  firstAt: number | null = null;
  lastAt: number | null = null;
  requests = 0;
  peakContext = 0;
  contextTokens = 0;
  compactions = 0;
  cost: CostSplit = ZERO_COST;
  idleRewrites = 0;
  idleRewriteUsd = 0;
  bigResults = 0;
  toolCalls = 0;
  toolErrors = 0;
  denials = 0;
  bashCommands = 0;
  cdCommands = 0;
  readonly reads = new Map<string, number>();
  readonly commands = new Map<string, number>();
  readonly spawns = new Map<string, number>();
  readonly families = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly toolIds = new Set<string>();
  private lastRequestAt: number | null = null;

  constructor(
    private readonly prices: PriceTable,
    private readonly hours: HourTally,
  ) {}

  ingest(record: TranscriptRecord): void {
    if (record.type === 'custom-title') {
      this.title = record.customTitle;
    } else if (record.type === 'ai-title') {
      this.title ??= record.aiTitle;
    } else if (hasBaseFields(record)) {
      this.base(record);
    }
  }

  private base(record: BaseRecord): void {
    this.cwd ??= record.cwd ?? null;
    const at = parseTimestamp(record.timestamp);
    this.firstAt ??= at;
    this.lastAt = at ?? this.lastAt;
    if (record.type === 'system') {
      this.compactions += record.subtype === 'compact_boundary' ? 1 : 0;
    } else if (record.type === 'assistant') {
      this.assistant(record, at);
    } else if (record.type === 'user' && Array.isArray(record.message.content)) {
      this.results(record.message.content);
    }
  }

  private assistant(record: AssistantRecord, at: number | null): void {
    const usage = firstUsage(record, this.seen);
    if (usage !== null) {
      this.request(record.message.model, usage, at);
    }
    for (const block of record.message.content) {
      if (block.type === 'tool_use' && !this.toolIds.has(block.id)) {
        this.toolIds.add(block.id);
        this.tool(block.name, block.input);
      }
    }
  }

  private request(model: string, usage: Usage, at: number | null): void {
    const context = usage.input + usage.cacheRead + usage.cacheWrite;
    this.requests += 1;
    this.contextTokens += context;
    this.peakContext = Math.max(this.peakContext, context);
    const cost = costOfUsage(model, usage, this.prices) ?? ZERO_COST;
    this.cost = addCost(this.cost, cost);
    const paused =
      at !== null && this.lastRequestAt !== null && at - this.lastRequestAt >= IDLE_GAP_MS;
    const rewrite =
      paused && usage.cacheWrite >= IDLE_REWRITE_MIN_TOKENS && usage.cacheWrite * 2 >= context;
    if (rewrite) {
      this.idleRewrites += 1;
      this.idleRewriteUsd += cost.cacheWrite;
    }
    this.lastRequestAt = at ?? this.lastRequestAt;
    this.hours.main({
      at,
      model,
      tokens: usage,
      cost,
      idleRewriteUsd: rewrite ? cost.cacheWrite : 0,
    });
  }

  private tool(name: string, input: unknown): void {
    this.toolCalls += 1;
    if (SEARCH_TOOLS.has(name)) {
      bump(this.families, 'search');
    }
    if (name === 'Read') {
      const file = stringField(input, 'file_path');
      if (file !== null) {
        bump(this.reads, file);
      }
    } else if (name === 'Bash') {
      this.bash(stringField(input, 'command') ?? '');
    } else if (SPAWN_TOOLS.has(name)) {
      bump(this.spawns, stringField(input, 'subagent_type') ?? 'general-purpose');
    }
  }

  private bash(command: string): void {
    this.bashCommands += 1;
    this.cdCommands += CD_FIRST.test(command) ? 1 : 0;
    const trimmed = command.trim();
    if (trimmed !== '') {
      bump(this.commands, trimmed);
    }
    for (const [family, patterns] of FAMILY_PATTERNS) {
      if (patterns.some((pattern) => pattern.test(command))) {
        bump(this.families, family);
      }
    }
  }

  private results(content: readonly ContentBlock[]): void {
    for (const block of content) {
      if (block.type !== 'tool_result') {
        continue;
      }
      this.bigResults += resultChars(block) > BIG_RESULT_CHARS ? 1 : 0;
      if (block.is_error === true) {
        this.toolErrors += 1;
        this.denials += DENIAL.test(resultText(block.content)) ? 1 : 0;
      }
    }
  }
}

interface SubagentTally {
  requests: number;
  premium: number;
  usd: number;
}

function tallySubagent(
  lines: readonly string[],
  prices: PriceTable,
  into: SubagentTally,
  hours: HourTally,
): void {
  const seen = new Set<string>();
  for (const line of lines) {
    const record = parseTranscriptLine(line);
    const usage = record?.type === 'assistant' ? firstUsage(record, seen) : null;
    if (record?.type !== 'assistant' || usage === null) {
      continue;
    }
    into.requests += 1;
    into.premium += isPremium(record.message.model) ? 1 : 0;
    const cost = costOfUsage(record.message.model, usage, prices) ?? ZERO_COST;
    into.usd += costTotal(cost);
    const { model } = record.message;
    hours.subagent({
      at: parseTimestamp(record.timestamp),
      model,
      tokens: usage,
      cost,
      idleRewriteUsd: 0,
    });
  }
}

function topRepeat(commands: ReadonlyMap<string, number>): RepeatedCommand | null {
  let best: RepeatedCommand | null = null;
  for (const [command, runs] of commands) {
    if (runs > 2 && (best === null || runs > best.runs)) {
      best = { command: oneLine(command, COMMAND_CHARS), runs };
    }
  }
  return best;
}

function familyCounts(families: ReadonlyMap<string, number>): Record<CommandFamily, number> {
  return {
    land: families.get('land') ?? 0,
    ci: families.get('ci') ?? 0,
    server: families.get('server') ?? 0,
    buildTest: families.get('buildTest') ?? 0,
    search: families.get('search') ?? 0,
  };
}

export function measureSession(input: MeasureInput): SessionMeasure {
  const prices = input.prices ?? DEFAULT_PRICES;
  const hours = new HourTally(prices);
  const main = new MainTally(prices, hours);
  for (const line of input.main) {
    const record = parseTranscriptLine(line);
    if (record !== null) {
      main.ingest(record);
    }
  }
  const sub: SubagentTally = { requests: 0, premium: 0, usd: 0 };
  for (const lines of input.subagents) {
    tallySubagent(lines, prices, sub, hours);
  }
  const prompts = transcriptPrompts(input.main, {
    sessionId: input.sessionId,
    fallbackAt: input.fallbackAt,
  });
  const fallbackTitle = prompts[0]?.text ?? `Session ${input.sessionId.slice(0, 8)}`;
  return {
    sessionId: input.sessionId,
    title: oneLine(main.title ?? fallbackTitle, TITLE_CHARS),
    cwd: main.cwd,
    startedAt: main.firstAt ?? input.fallbackAt,
    updatedAt: main.lastAt ?? input.fallbackAt,
    prompts: prompts.length,
    requests: main.requests,
    peakContext: main.peakContext,
    contextTokens: main.contextTokens,
    compactions: main.compactions,
    cost: main.cost,
    idleRewrites: main.idleRewrites,
    idleRewriteUsd: main.idleRewriteUsd,
    bigResults: main.bigResults,
    extraReads: beyond(main.reads, 2),
    repeatedRuns: beyond(main.commands, 2),
    topRepeat: topRepeat(main.commands),
    toolCalls: main.toolCalls,
    toolErrors: main.toolErrors,
    denials: main.denials,
    bashCommands: main.bashCommands,
    cdCommands: main.cdCommands,
    spawns: Object.fromEntries(main.spawns),
    subagentRequests: sub.requests,
    premiumSubagentRequests: sub.premium,
    subagentUsd: sub.usd,
    families: familyCounts(main.families),
    hours: hours.hours(),
  };
}
