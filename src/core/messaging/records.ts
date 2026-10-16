// Zod schemas for the transcript records that carry messages between agents
// and sessions. The transcript format is undocumented, so every field falls
// back to a neutral value instead of failing the line.
//
// Sends are SendMessage tool_use blocks in assistant records. Deliveries are
// user records or queued_command attachments with an `origin` object:
//   kind "peer": another agent or session (handback true for a subagent's report)
//   kind "coordinator": the agent that launched this subagent
//   kind "task-notification": a background task, including a finished agent

import { z } from 'zod';

const looseString = z.string().nullable().catch(null);
const looseBoolean = z.boolean().nullable().catch(null);

const originSchema = z
  .object({
    kind: z.string().catch(''),
    from: looseString,
    name: looseString,
    senderTaskId: looseString,
    body: looseString,
    handback: looseBoolean,
    handbackReportText: looseString,
  })
  .nullable()
  .catch(null);

export type MessageOrigin = NonNullable<z.infer<typeof originSchema>>;

const OTHER_BLOCK: { type: 'other' } = { type: 'other' };
const OTHER_PART: { type: string; text: null } = { type: 'other', text: null };

const blockSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({
      type: z.literal('tool_use'),
      id: z.string(),
      name: z.string(),
      input: z.unknown(),
    }),
    z.object({
      type: z.literal('tool_result'),
      tool_use_id: z.string(),
      is_error: looseBoolean,
      content: z
        .union([
          z.string(),
          z.array(z.object({ type: z.string(), text: looseString }).catch(OTHER_PART)),
        ])
        .catch(''),
    }),
    z.object({ type: z.literal('other') }),
  ])
  .catch(OTHER_BLOCK);

export type MessageBlock = z.infer<typeof blockSchema>;

const baseFields = { uuid: looseString, timestamp: looseString };

const recordSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('assistant'),
    ...baseFields,
    message: z.object({ content: z.array(blockSchema).catch([]) }),
  }),
  z.object({
    type: z.literal('user'),
    ...baseFields,
    origin: originSchema,
    message: z.object({ content: z.union([z.string(), z.array(blockSchema)]).catch('') }),
  }),
  z.object({
    type: z.literal('attachment'),
    ...baseFields,
    attachment: z.object({
      type: z.literal('queued_command'),
      prompt: z.string().catch(''),
      origin: originSchema,
    }),
  }),
]);

export type MessageRecord = z.infer<typeof recordSchema>;

/** Substrings that every line we read contains, so other lines skip JSON.parse. */
const MARKERS: readonly string[] = ['"SendMessage"', '"origin"', '"tool_result"'];

export function mayHoldMessage(line: string): boolean {
  return MARKERS.some((marker) => line.includes(marker));
}

/** One JSONL line as a record we read, or null for anything else. */
export function parseMessageRecord(line: string): MessageRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const result = recordSchema.safeParse(value);
  return result.success ? result.data : null;
}
