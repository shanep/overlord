// Zod schemas for the SDK messages the harness consumes. Everything else the
// SDK emits parses to null and is ignored, so new message types never break a
// session.

import { z } from 'zod';

const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
});

export type SdkUsage = z.infer<typeof usageSchema>;

const initSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  model: z.string(),
  cwd: z.string(),
  tools: z.array(z.string()),
  permissionMode: z.string(),
  mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })),
  claude_code_version: z.string().optional(),
});

const assistantSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    id: z.string(),
    model: z.string(),
    content: z.array(z.unknown()),
    usage: usageSchema.nullish(),
  }),
  parent_tool_use_id: z.string().nullable(),
  request_id: z.string().optional(),
  agent_id: z.string().optional(),
});

const userSchema = z.object({
  type: z.literal('user'),
  message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
});

const resultSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  num_turns: z.number(),
  duration_ms: z.number(),
  total_cost_usd: z.number(),
  usage: usageSchema,
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
});

const taskStartedSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_started'),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  description: z.string(),
  subagent_type: z.string().optional(),
  task_type: z.string().optional(),
  is_backgrounded: z.boolean().optional(),
  spawn_depth: z.number().optional(),
  parent_task_id: z.string().optional(),
});

const taskNotificationSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_notification'),
  task_id: z.string(),
  status: z.enum(['completed', 'failed', 'stopped']),
  summary: z.string(),
});

const rateLimitSchema = z.object({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.object({
    rateLimitType: z.string().optional(),
    utilization: z.number().optional(),
    resetsAt: z.number().optional(),
  }),
});

const compactSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('compact_boundary'),
  compact_metadata: z.object({ trigger: z.string(), pre_tokens: z.number() }),
});

const messageSchema = z.union([
  initSchema,
  assistantSchema,
  userSchema,
  resultSchema,
  taskStartedSchema,
  taskNotificationSchema,
  rateLimitSchema,
  compactSchema,
]);

export type SdkEvent = z.infer<typeof messageSchema>;
export type InitMessage = z.infer<typeof initSchema>;
export type AssistantMessage = z.infer<typeof assistantSchema>;
export type ResultMessage = z.infer<typeof resultSchema>;
export type TaskStartedMessage = z.infer<typeof taskStartedSchema>;
export type TaskNotificationMessage = z.infer<typeof taskNotificationSchema>;
export type RateLimitMessage = z.infer<typeof rateLimitSchema>;

export function parseSdkMessage(raw: unknown): SdkEvent | null {
  const parsed = messageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const assistantBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
]);

export type AssistantBlock = z.infer<typeof assistantBlockSchema>;

/** The text, thinking and tool_use blocks of a message, in order. */
export function assistantBlocks(content: readonly unknown[]): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const raw of content) {
    const parsed = assistantBlockSchema.safeParse(raw);
    if (parsed.success) {
      blocks.push(parsed.data);
    }
  }
  return blocks;
}

const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() });

const toolResultSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
});

export interface ToolResultBlock {
  readonly toolUseId: string;
  readonly ok: boolean;
  readonly text: string;
}

function contentText(content: string | readonly unknown[] | undefined): string {
  if (content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  const parts: string[] = [];
  for (const raw of content) {
    const parsed = textBlockSchema.safeParse(raw);
    if (parsed.success) {
      parts.push(parsed.data.text);
    }
  }
  return parts.join('\n');
}

/** The tool_result blocks of a user message. A string message has none. */
export function toolResults(content: string | readonly unknown[]): ToolResultBlock[] {
  if (typeof content === 'string') {
    return [];
  }
  const results: ToolResultBlock[] = [];
  for (const raw of content) {
    const parsed = toolResultSchema.safeParse(raw);
    if (parsed.success) {
      results.push({
        toolUseId: parsed.data.tool_use_id,
        ok: parsed.data.is_error !== true,
        text: contentText(parsed.data.content),
      });
    }
  }
  return results;
}

const contextUsageSchema = z.object({
  totalTokens: z.number(),
  maxTokens: z.number(),
  categories: z.array(
    z.object({ name: z.string(), tokens: z.number(), kind: z.string().optional() }),
  ),
});

export interface ContextUsage {
  readonly totalTokens: number;
  readonly maxTokens: number;
  /** totalTokens / maxTokens, 0 to 1 or more when over the limit. */
  readonly fill: number;
  readonly categories: readonly {
    readonly name: string;
    readonly tokens: number;
    readonly kind: string | null;
  }[];
}

export function parseContextUsage(raw: unknown): ContextUsage {
  const parsed = contextUsageSchema.parse(raw);
  return {
    totalTokens: parsed.totalTokens,
    maxTokens: parsed.maxTokens,
    fill: parsed.maxTokens > 0 ? parsed.totalTokens / parsed.maxTokens : 0,
    categories: parsed.categories.map((category) => ({
      name: category.name,
      tokens: category.tokens,
      kind: category.kind ?? null,
    })),
  };
}
