// Zod schemas for the Copilot CLI events Overlord reads from
// ~/.copilot/session-state/<id>/events.jsonl. The package ships the full
// schema (session-events.schema.json, 153 event types), but these only
// check the fields the accumulator uses, and any field that does not match
// falls back to a neutral value instead of failing the line. Unknown event
// types still parse as an envelope and are skipped by the accumulator.
// Checked against Copilot CLI 1.0.89.
// cspell:words Aiu

import { z } from 'zod';

const looseString = z.string().nullish().catch(null);
const looseNumber = z.number().nullish().catch(null);
const looseBoolean = z.boolean().nullish().catch(null);
const count = z.number().nonnegative().catch(0);

/** Every line is one of these. Subagent events name their thread in agentId. */
const envelopeSchema = z.object({
  type: z.string(),
  data: z.unknown(),
  id: looseString,
  timestamp: z.string(),
  ephemeral: looseBoolean,
  agentId: looseString,
});

export type Envelope = z.infer<typeof envelopeSchema>;

export const sessionStartSchema = z.object({
  sessionId: looseString,
  copilotVersion: looseString,
  selectedModel: looseString,
  reasoningEffort: looseString,
  context: z.object({ cwd: looseString, branch: looseString }).nullish().catch(null),
});

export const sessionResumeSchema = z.object({
  selectedModel: looseString,
  reasoningEffort: looseString,
  context: z.object({ cwd: looseString, branch: looseString }).nullish().catch(null),
});

export type SessionResume = z.infer<typeof sessionResumeSchema>;

export const modelChangeSchema = z.object({
  newModel: looseString,
  reasoningEffort: looseString,
});

export const modeChangedSchema = z.object({ newMode: looseString });

export const titleSchema = z.object({ title: looseString });

export const userMessageSchema = z.object({
  content: z.string().catch(''),
  messageId: looseString,
});

const toolRequestSchema = z.object({
  toolCallId: z.string(),
  name: z.string().catch('tool'),
  arguments: z.unknown(),
});

export const assistantMessageSchema = z.object({
  messageId: z.string(),
  model: looseString,
  content: z.string().catch(''),
  reasoningText: looseString,
  toolRequests: z.array(toolRequestSchema.nullable().catch(null)).catch([]),
  apiCallId: looseString,
  outputTokens: looseNumber,
  parentToolCallId: looseString,
});

export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

/** One model call's usage. Ephemeral in 1.0.89, so it only shows up in streams, not in events.jsonl. */
export const assistantUsageSchema = z.object({
  model: looseString,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  reasoningTokens: count,
  duration: looseNumber,
  timeToFirstTokenMs: looseNumber,
  apiCallId: looseString,
  copilotUsage: z.object({ totalNanoAiu: looseNumber }).nullish().catch(null),
});

export type AssistantUsage = z.infer<typeof assistantUsageSchema>;

export const toolStartSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string().catch('tool'),
  arguments: z.unknown(),
});

export type ToolStart = z.infer<typeof toolStartSchema>;

export const toolCompleteSchema = z.object({
  toolCallId: z.string(),
  success: z.boolean().catch(false),
  result: z.object({ content: looseString }).nullish().catch(null),
  error: z.object({ message: looseString, code: looseString }).nullish().catch(null),
});

export type ToolComplete = z.infer<typeof toolCompleteSchema>;

export const requestIdSchema = z.object({ requestId: z.string() });

const tokenCount = z.object({ tokenCount: count }).nullish().catch(null);

const tokenDetailsSchema = z
  .object({
    input: tokenCount,
    cache_read: tokenCount,
    cache_write: tokenCount,
    output: tokenCount,
  })
  .nullish()
  .catch(null);

const modelMetricSchema = z.object({
  usage: z
    .object({
      inputTokens: count,
      outputTokens: count,
      cacheReadTokens: count,
      cacheWriteTokens: count,
      reasoningTokens: count,
    })
    .nullish()
    .catch(null),
  totalNanoAiu: looseNumber,
  tokenDetails: tokenDetailsSchema,
});

export type ModelMetric = z.infer<typeof modelMetricSchema>;

const modelMetricsSchema = z.record(z.string(), modelMetricSchema.catch({})).catch({});

export const shutdownSchema = z.object({
  shutdownType: looseString,
  totalNanoAiu: looseNumber,
  modelMetrics: modelMetricsSchema,
  agentMetrics: z
    .record(z.string(), z.object({ modelMetrics: modelMetricsSchema }).catch({ modelMetrics: {} }))
    .nullish()
    .catch(null),
  currentModel: looseString,
  currentTokens: looseNumber,
});

export type Shutdown = z.infer<typeof shutdownSchema>;

export const checkpointSchema = z.object({ totalNanoAiu: looseNumber });

export const usageInfoSchema = z.object({ tokenLimit: count, currentTokens: count });

export const compactionSchema = z.object({ success: z.boolean().catch(false) });

export const subagentStartSchema = z.object({
  toolCallId: z.string(),
  agentName: z.string().catch('subagent'),
  agentDisplayName: looseString,
  agentDescription: looseString,
  model: looseString,
  executionMode: looseString,
});

export type SubagentStart = z.infer<typeof subagentStartSchema>;

export const subagentEndSchema = z.object({
  toolCallId: z.string(),
  model: looseString,
});

export type SubagentEnd = z.infer<typeof subagentEndSchema>;

/** The envelope of one line, or null when the line is not a Copilot event. */
export function parseEnvelope(line: string): Envelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = envelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Epoch ms from an ISO timestamp, or null when it does not parse. */
export function parseTime(value: string): number | null {
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}
