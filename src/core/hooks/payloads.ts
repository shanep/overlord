// Zod schemas for the JSON that Claude Code writes to a hook's stdin.
// Objects are loose because Claude Code adds fields between releases, and an
// event we do not model still parses to the common shape.

import { z } from 'zod';

const optionalString = z.string().nullish();

const commonShape = {
  session_id: z.string(),
  hook_event_name: z.string(),
  transcript_path: optionalString,
  cwd: optionalString,
  permission_mode: optionalString,
  prompt_id: optionalString,
  agent_id: optionalString,
  agent_type: optionalString,
};

const commonPayloadSchema = z.looseObject(commonShape);

const toolShape = {
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_use_id: optionalString,
};

const preToolUseSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('PreToolUse'),
  ...toolShape,
});

const postToolUseSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('PostToolUse'),
  ...toolShape,
  tool_response: z.unknown(),
  duration_ms: z.number().nullish(),
});

const postToolUseFailureSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('PostToolUseFailure'),
  ...toolShape,
  error: z.string(),
  is_interrupt: z.boolean().nullish(),
  duration_ms: z.number().nullish(),
});

const userPromptSubmitSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('UserPromptSubmit'),
  prompt: z.string(),
  session_title: optionalString,
});

const sessionStartSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('SessionStart'),
  source: z.string(),
  model: optionalString,
  session_title: optionalString,
});

const sessionEndSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('SessionEnd'),
  reason: z.string(),
});

const stopSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('Stop'),
  stop_hook_active: z.boolean().nullish(),
  last_assistant_message: optionalString,
});

const subagentStartSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('SubagentStart'),
  agent_id: z.string(),
  agent_type: z.string(),
});

const subagentStopSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('SubagentStop'),
  agent_id: z.string(),
  agent_type: z.string(),
  stop_hook_active: z.boolean().nullish(),
  agent_transcript_path: optionalString,
  last_assistant_message: optionalString,
});

const preCompactSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('PreCompact'),
  trigger: z.string(),
  custom_instructions: optionalString,
});

const postCompactSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('PostCompact'),
  trigger: z.string(),
  compact_summary: optionalString,
});

const notificationSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('Notification'),
  message: z.string(),
  title: optionalString,
  notification_type: optionalString,
});

const permissionRequestSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('PermissionRequest'),
  tool_name: z.string(),
  tool_input: z.unknown(),
  permission_suggestions: z.array(z.unknown()).nullish(),
});

const permissionDeniedSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('PermissionDenied'),
  ...toolShape,
  reason: optionalString,
});

const instructionsLoadedSchema = commonPayloadSchema.extend({
  hook_event_name: z.literal('InstructionsLoaded'),
  file_path: z.string(),
  memory_type: z.string(),
  load_reason: z.string(),
  globs: z.array(z.string()).nullish(),
  trigger_file_path: optionalString,
  parent_file_path: optionalString,
});

export const knownPayloadSchema = z.discriminatedUnion('hook_event_name', [
  preToolUseSchema,
  postToolUseSchema,
  postToolUseFailureSchema,
  userPromptSubmitSchema,
  sessionStartSchema,
  sessionEndSchema,
  stopSchema,
  subagentStartSchema,
  subagentStopSchema,
  preCompactSchema,
  postCompactSchema,
  notificationSchema,
  permissionRequestSchema,
  permissionDeniedSchema,
  instructionsLoadedSchema,
]);

type CommonPayload = z.infer<typeof commonPayloadSchema>;
export type KnownPayload = z.infer<typeof knownPayloadSchema>;
export type KnownEventName = KnownPayload['hook_event_name'];
export type InstructionsLoadedPayload = z.infer<typeof instructionsLoadedSchema>;
export type SubagentStartPayload = z.infer<typeof subagentStartSchema>;
export type SubagentStopPayload = z.infer<typeof subagentStopSchema>;

export const KNOWN_EVENT_NAMES: readonly KnownEventName[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
  'PermissionRequest',
  'PermissionDenied',
  'InstructionsLoaded',
];

const KNOWN_SET: ReadonlySet<string> = new Set(KNOWN_EVENT_NAMES);

/** A parsed hook input. `known` is false for events we do not model, or a known event with an unexpected shape. */
type ParsedHookPayload =
  | { readonly known: true; readonly payload: KnownPayload }
  | { readonly known: false; readonly payload: CommonPayload };

export type HookParseResult =
  | { readonly ok: true; readonly value: ParsedHookPayload }
  | { readonly ok: false; readonly error: string };

export function parseHookPayload(value: unknown): HookParseResult {
  const common = commonPayloadSchema.safeParse(value);
  if (!common.success) {
    return { ok: false, error: z.prettifyError(common.error) };
  }
  if (KNOWN_SET.has(common.data.hook_event_name)) {
    const known = knownPayloadSchema.safeParse(value);
    if (known.success) {
      return { ok: true, value: { known: true, payload: known.data } };
    }
  }
  return { ok: true, value: { known: false, payload: common.data } };
}
