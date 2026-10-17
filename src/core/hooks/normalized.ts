// Hook events and answers in Overlord's own terms. Each agent's hooks facet
// turns its stdin JSON into a NormalizedHookEvent and turns a HookAnswer back
// into the JSON that agent reads, so the server, the coordinator and the
// launch check never see one agent's field names.
//
// Do not assume an order. Copilot CLI 1.0.89 fires userPromptSubmitted
// before sessionStart, and over ACP it fires sessionEnd after every prompt.

import type { AgentId } from '../../shared/agents.js';
import type { PermissionDecision } from '../../shared/model.js';

import type { HookOutput } from './protocol.js';
import { stringField } from './rules.js';

/** A tool call as a hook reports it. */
export interface HookToolCall {
  readonly name: string;
  readonly input: unknown;
  /** The agent's id for the call, or null when its hooks send none (Copilot). */
  readonly useId: string | null;
}

/** How a session started. Claude says startup, Copilot says new: both are 'new'. */
export type SessionStartSource = 'new' | 'resume' | 'clear' | 'compact' | 'fork' | 'other';

/** The fields every hook event has. */
export interface HookEventBase {
  readonly agent: AgentId;
  /** The agent's own name for the event. Answers echo it back. */
  readonly native: string;
  readonly sessionId: string;
  /** The subagent the hook fired in, or null on the main thread. */
  readonly subagentId: string | null;
  readonly cwd: string | null;
  readonly transcriptPath: string | null;
  /** Epoch milliseconds from the payload, or null when the agent sends no time (Claude). */
  readonly timestamp: number | null;
}

interface SessionStart extends HookEventBase {
  readonly kind: 'session-start';
  readonly source: SessionStartSource;
  readonly model: string | null;
  readonly title: string | null;
}

interface SessionEnd extends HookEventBase {
  readonly kind: 'session-end';
  readonly reason: string;
}

interface PromptSubmit extends HookEventBase {
  readonly kind: 'prompt-submit';
  readonly prompt: string;
  readonly title: string | null;
}

interface PreToolUse extends HookEventBase {
  readonly kind: 'pre-tool-use';
  readonly tool: HookToolCall;
}

interface PostToolUse extends HookEventBase {
  readonly kind: 'post-tool-use';
  readonly tool: HookToolCall;
  readonly response: unknown;
}

interface ToolFailed extends HookEventBase {
  readonly kind: 'tool-failed';
  readonly tool: HookToolCall;
  readonly error: string;
}

interface PermissionAsked extends HookEventBase {
  readonly kind: 'permission-request';
  readonly tool: HookToolCall;
}

interface PermissionDenied extends HookEventBase {
  readonly kind: 'permission-denied';
  readonly tool: HookToolCall;
  readonly reason: string | null;
}

/** The subagent a subagent event is about. */
interface HookSubagent {
  readonly id: string;
  readonly type: string;
}

interface SubagentStart extends HookEventBase {
  readonly kind: 'subagent-start';
  readonly subagent: HookSubagent;
}

interface SubagentStop extends HookEventBase {
  readonly kind: 'subagent-stop';
  readonly subagent: HookSubagent;
  readonly subagentTranscriptPath: string | null;
}

interface Stop extends HookEventBase {
  readonly kind: 'stop';
  readonly lastMessage: string | null;
}

interface Compaction extends HookEventBase {
  readonly kind: 'compaction';
  readonly phase: 'before' | 'after';
  /** manual or auto. */
  readonly trigger: string;
}

interface Notification extends HookEventBase {
  readonly kind: 'notification';
  readonly message: string;
  readonly title: string | null;
}

/** An instruction file the agent loaded. Only Claude reports these so far. */
interface InstructionsLoaded extends HookEventBase {
  readonly kind: 'instructions-loaded';
  readonly file: string;
  readonly memoryType: string;
  readonly loadReason: string;
  readonly globs: readonly string[];
  readonly triggerPath: string | null;
  readonly parentPath: string | null;
}

/** An event Overlord does not model, or a modelled one in a shape it did not expect. */
interface OtherEvent extends HookEventBase {
  readonly kind: 'other';
}

export type NormalizedHookEvent =
  | SessionStart
  | SessionEnd
  | PromptSubmit
  | PreToolUse
  | PostToolUse
  | ToolFailed
  | PermissionAsked
  | PermissionDenied
  | SubagentStart
  | SubagentStop
  | Stop
  | Compaction
  | Notification
  | InstructionsLoaded
  | OtherEvent;

export type HookEventKind = NormalizedHookEvent['kind'];

export type HookEventOf<K extends HookEventKind> = Extract<
  NormalizedHookEvent,
  { readonly kind: K }
>;

export type HookNormalizeResult =
  | { readonly ok: true; readonly event: NormalizedHookEvent }
  | { readonly ok: false; readonly error: string };

/** What a hook relay forwards: the agent's stdin JSON and, when the relay was told, the event name. */
export interface RawHook {
  readonly payload: unknown;
  /** From the relay's --event flag, for agents whose stdin does not name the event (Copilot). */
  readonly name: string | null;
}

/**
 * What Overlord says back to a hook. Every field is optional and an empty
 * answer means no opinion. Each agent's facet writes it in that agent's JSON.
 */
export interface HookAnswer {
  /** The decision on a permission request. */
  readonly decision?: PermissionDecision;
  /** Stops a tool call before it runs. The text tells the model why. */
  readonly block?: string;
  /** Text added to the model's context. */
  readonly context?: string;
  /** Text shown to the user and not the model. */
  readonly notice?: string;
}

/** How one agent's hooks talk: its stdin read into an event, and an answer written in its JSON. */
export interface HookDialect {
  normalize: (raw: RawHook) => HookNormalizeResult;
  /** The JSON the hook prints. An empty answer gives {}. */
  answer: (event: NormalizedHookEvent, answer: HookAnswer) => HookOutput;
}

/** Tool names that write files, each with the input fields that can hold the path, tried in order. */
export type EditTools = Readonly<Record<string, readonly string[]>>;

/** The file an edit tool call writes, or null for any other tool. */
export function editedFile(tools: EditTools, call: HookToolCall): string | null {
  const fields = Object.hasOwn(tools, call.name) ? tools[call.name] : undefined;
  for (const field of fields ?? []) {
    const value = stringField(call.input, field);
    if (value !== null) {
      return value === '' ? null : value;
    }
  }
  return null;
}

function joined(before: string | undefined, text: string): string {
  return before === undefined || before === '' ? text : `${before}\n\n${text}`;
}

/** The answer with text added to its context. Null text leaves it as it is. */
export function withContextNote(answer: HookAnswer | null, text: string | null): HookAnswer | null {
  if (text === null) {
    return answer;
  }
  return { ...answer, context: joined(answer?.context, text) };
}

/** The answer with text added to its notice for the user. Null text leaves it as it is. */
export function withNotice(answer: HookAnswer | null, text: string | null): HookAnswer | null {
  if (text === null) {
    return answer;
  }
  return { ...answer, notice: joined(answer?.notice, text) };
}

/** The model's id for the agent a hook fired in: the subagent, else the session. */
export function hookAgentId(event: NormalizedHookEvent): string {
  return event.subagentId ?? event.sessionId;
}
