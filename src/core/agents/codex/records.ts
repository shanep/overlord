// Zod schemas for the Codex rollout records Overlord reads. Each line of
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl is {timestamp, ordinal, type,
// payload}. The format is undocumented, so every field falls back to a
// neutral value and an unknown record type is skipped, not an error.
// Checked against Codex CLI 0.163.0 (test/fixtures/codex/0.163.0).

import { z } from 'zod';

/** The Codex versions whose rollout files these schemas were checked against. */
export const TESTED_CODEX_VERSIONS: readonly string[] = ['0.163.0'];

const looseString = z.string().nullable().catch(null);
const looseNumber = z.number().nullable().catch(null);
const count = z.number().nonnegative().catch(0);

const envelopeSchema = z.object({
  timestamp: looseString,
  type: z.string(),
  payload: z.unknown(),
});

const sessionMetaSchema = z.object({
  id: looseString,
  timestamp: looseString,
  cwd: looseString,
  originator: looseString,
  cli_version: looseString,
  source: looseString,
  git: z.object({ branch: looseString }).nullable().catch(null),
});

const turnContextSchema = z.object({
  turn_id: looseString,
  cwd: looseString,
  approval_policy: looseString,
  sandbox_policy: z.object({ type: looseString }).nullable().catch(null),
  model: looseString,
  effort: looseString,
});

const threadSettingsSchema = z.object({
  thread_settings: z
    .object({
      model: looseString,
      approval_policy: looseString,
      reasoning_effort: looseString,
    })
    .nullable()
    .catch(null),
});

/** One usage block, in Codex's own words. Cached input is part of input, not on top of it. */
const usageSchema = z.object({
  input_tokens: count,
  cached_input_tokens: count,
  cache_write_input_tokens: count,
  output_tokens: count,
  reasoning_output_tokens: count,
});

export type CodexUsage = z.infer<typeof usageSchema>;

const tokenUsageRecordSchema = z.object({
  response_id: z.string(),
  turn_id: looseString,
  usage: usageSchema,
});

const rateWindowSchema = z
  .object({
    used_percent: looseNumber,
    window_minutes: looseNumber,
    /** Epoch seconds. */
    resets_at: looseNumber,
  })
  .nullable()
  .catch(null);

const tokenCountSchema = z.object({
  info: z.object({ model_context_window: looseNumber }).nullable().catch(null),
  rate_limits: z
    .object({
      limit_id: looseString,
      primary: rateWindowSchema,
      secondary: rateWindowSchema,
      plan_type: looseString,
    })
    .nullable()
    .catch(null),
});

export type CodexRateLimits = NonNullable<z.infer<typeof tokenCountSchema>['rate_limits']>;
export type CodexRateWindow = NonNullable<CodexRateLimits['primary']>;

const textPart = z
  .object({ type: looseString, text: looseString })
  .catch({ type: null, text: null });

const itemSchema = z.object({
  type: z.string().catch('other'),
  id: z.string().catch(''),
  content: z.array(textPart).catch([]),
  /** CommandExecution: an argv array, or one string in other versions. */
  command: z
    .union([z.array(z.string()), z.string()])
    .nullable()
    .catch(null),
  cwd: looseString,
  status: looseString,
  aggregated_output: looseString,
  exit_code: looseNumber,
  /** FileChange: changes keyed by path. */
  changes: z
    .record(
      z.string(),
      z.object({ type: looseString, unified_diff: looseString }).catch({
        type: null,
        unified_diff: null,
      }),
    )
    .nullable()
    .catch(null),
  stdout: looseString,
  stderr: looseString,
});

export type CodexItem = z.infer<typeof itemSchema>;

const itemCompletedSchema = z.object({
  turn_id: looseString,
  item: itemSchema,
  started_at_ms: looseNumber,
  completed_at_ms: looseNumber,
});

const turnEndSchema = z.object({ turn_id: looseString, reason: looseString });

const taskStartedSchema = z.object({
  turn_id: looseString,
  model_context_window: looseNumber,
});

const errorSchema = z.object({ message: looseString });

const customToolCallSchema = z.object({
  call_id: z.string(),
  name: z.string().catch('exec'),
  input: z.string().catch(''),
});

const toolOutputSchema = z.object({
  call_id: z.string(),
  output: z.union([z.string(), z.array(textPart)]).catch(''),
});

const reasoningSchema = z.object({
  id: looseString,
  summary: z.array(textPart).catch([]),
});

const payloadType = z.object({ type: z.string() });

type At = number | null;

/** What sets up the session: its folder, version, model, effort, permissions and limits. */
export type SettingsRecord =
  | {
      readonly group: 'settings';
      readonly kind: 'session_meta';
      readonly at: At;
      readonly meta: z.infer<typeof sessionMetaSchema>;
    }
  | {
      readonly group: 'settings';
      readonly kind: 'turn_context';
      readonly at: At;
      readonly context: z.infer<typeof turnContextSchema>;
    }
  | {
      readonly group: 'settings';
      readonly kind: 'thread_settings';
      readonly at: At;
      readonly settings: NonNullable<z.infer<typeof threadSettingsSchema>['thread_settings']>;
    }
  | {
      readonly group: 'settings';
      readonly kind: 'token_count';
      readonly at: At;
      readonly tokens: z.infer<typeof tokenCountSchema>;
    };

/** Turns opening and closing, the model calls in them, and errors. */
export type TurnRecord =
  | {
      readonly group: 'turn';
      readonly kind: 'task_started';
      readonly at: At;
      readonly started: z.infer<typeof taskStartedSchema>;
    }
  | {
      readonly group: 'turn';
      readonly kind: 'task_complete';
      readonly at: At;
      readonly turnId: string | null;
    }
  | {
      readonly group: 'turn';
      readonly kind: 'turn_aborted';
      readonly at: At;
      readonly reason: string | null;
    }
  | {
      readonly group: 'turn';
      readonly kind: 'usage';
      readonly at: At;
      readonly record: z.infer<typeof tokenUsageRecordSchema>;
    }
  | { readonly group: 'turn'; readonly kind: 'error'; readonly at: At; readonly message: string };

/** What was said and done: messages, reasoning, tool calls and their output. */
export type ContentRecord =
  | {
      readonly group: 'content';
      readonly kind: 'item';
      readonly at: At;
      readonly completed: z.infer<typeof itemCompletedSchema>;
    }
  | {
      readonly group: 'content';
      readonly kind: 'tool_call';
      readonly at: At;
      readonly call: z.infer<typeof customToolCallSchema>;
    }
  | {
      readonly group: 'content';
      readonly kind: 'tool_output';
      readonly at: At;
      readonly output: z.infer<typeof toolOutputSchema>;
    }
  | {
      readonly group: 'content';
      readonly kind: 'reasoning';
      readonly at: At;
      readonly reasoning: z.infer<typeof reasoningSchema>;
    };

/** A rollout line, grouped so a reader can take one group at a time. Lines Overlord does not read are "other". */
export type CodexRecord =
  | SettingsRecord
  | TurnRecord
  | ContentRecord
  | { readonly group: 'other'; readonly kind: 'other'; readonly at: At };

function parseTime(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : ms;
}

type Parser = (at: number | null, payload: unknown) => CodexRecord | null;

/** Parses a payload with schema and builds the record, or null when the payload does not fit. */
function parser<T>(
  schema: z.ZodType<T>,
  make: (at: number | null, data: T) => CodexRecord | null,
): Parser {
  return (at, payload) => {
    const parsed = schema.safeParse(payload);
    return parsed.success ? make(at, parsed.data) : null;
  };
}

/** event_msg payloads by their type. */
const EVENTS: Readonly<Record<string, Parser>> = {
  task_started: parser(taskStartedSchema, (at, started) => ({
    group: 'turn',
    kind: 'task_started',
    at,
    started,
  })),
  task_complete: parser(turnEndSchema, (at, end) => ({
    group: 'turn',
    kind: 'task_complete',
    at,
    turnId: end.turn_id,
  })),
  turn_aborted: parser(turnEndSchema, (at, end) => ({
    group: 'turn',
    kind: 'turn_aborted',
    at,
    reason: end.reason,
  })),
  token_count: parser(tokenCountSchema, (at, tokens) => ({
    group: 'settings',
    kind: 'token_count',
    at,
    tokens,
  })),
  item_completed: parser(itemCompletedSchema, (at, completed) => ({
    group: 'content',
    kind: 'item',
    at,
    completed,
  })),
  thread_settings_applied: parser(threadSettingsSchema, (at, { thread_settings: settings }) =>
    settings === null ? null : { group: 'settings', kind: 'thread_settings', at, settings },
  ),
  error: parser(errorSchema, (at, { message }) =>
    message === null ? null : { group: 'turn', kind: 'error', at, message },
  ),
};

const toolCall = parser(customToolCallSchema, (at, call) => ({
  group: 'content',
  kind: 'tool_call',
  at,
  call,
}));
const toolOutput = parser(toolOutputSchema, (at, output) => ({
  group: 'content',
  kind: 'tool_output',
  at,
  output,
}));

/** response_item payloads by their type. Older Codex versions called tools as function calls. */
const RESPONSE_ITEMS: Readonly<Record<string, Parser>> = {
  custom_tool_call: toolCall,
  function_call: toolCall,
  custom_tool_call_output: toolOutput,
  function_call_output: toolOutput,
  reasoning: parser(reasoningSchema, (at, reasoning) => ({
    group: 'content',
    kind: 'reasoning',
    at,
    reasoning,
  })),
};

/** The table's own parser for a type, so a type like "toString" finds nothing. */
function parserFor(table: Readonly<Record<string, Parser>>, type: string): Parser | undefined {
  return Object.hasOwn(table, type) ? table[type] : undefined;
}

/** Picks the parser by payload.type from table. */
function byPayloadType(table: Readonly<Record<string, Parser>>): Parser {
  return (at, payload) => {
    const type = payloadType.safeParse(payload);
    const parse = type.success ? parserFor(table, type.data.type) : undefined;
    return parse === undefined ? null : parse(at, payload);
  };
}

/** Rollout lines by their type. */
const RECORDS: Readonly<Record<string, Parser>> = {
  session_meta: parser(sessionMetaSchema, (at, meta) => ({
    group: 'settings',
    kind: 'session_meta',
    at,
    meta,
  })),
  turn_context: parser(turnContextSchema, (at, context) => ({
    group: 'settings',
    kind: 'turn_context',
    at,
    context,
  })),
  token_usage_record: parser(tokenUsageRecordSchema, (at, record) => ({
    group: 'turn',
    kind: 'usage',
    at,
    record,
  })),
  event_msg: byPayloadType(EVENTS),
  response_item: byPayloadType(RESPONSE_ITEMS),
};

/** One rollout line, or null when it is not JSON with a type. A type Overlord does not read is "other". */
export function parseRolloutLine(line: string): CodexRecord | null {
  if (line.trim() === '') {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) {
    return null;
  }
  const { timestamp, type, payload } = envelope.data;
  const at = parseTime(timestamp);
  return parserFor(RECORDS, type)?.(at, payload) ?? { group: 'other', kind: 'other', at };
}

/** The text of a list of message parts, joined. */
export function partsText(parts: readonly { readonly text: string | null }[]): string {
  return parts.flatMap((part) => (part.text === null ? [] : [part.text])).join('');
}
