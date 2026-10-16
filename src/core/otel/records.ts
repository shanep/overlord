// Typed records decoded from Claude Code's OTLP exports.

import type { Attributes } from './otlp.js';

interface RecordBase {
  /** Epoch milliseconds. */
  readonly time: number;
  readonly sessionId: string | null;
  readonly attributes: Attributes;
  readonly resource: Attributes;
}

export interface MetricPointRecord extends RecordBase {
  readonly kind: 'metric';
  /** For example claude_code.cost.usage or claude_code.token.usage. */
  readonly name: string;
  readonly metricType: 'sum' | 'gauge' | 'histogram';
  readonly unit: string | null;
  readonly value: number;
  readonly startTime: number | null;
}

export interface ApiRequestRecord extends RecordBase {
  readonly kind: 'api_request';
  readonly model: string | null;
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly requestId: string | null;
  readonly querySource: string | null;
  readonly sequence: number | null;
}

interface ApiErrorRecord extends RecordBase {
  readonly kind: 'api_error';
  readonly model: string | null;
  readonly error: string | null;
  readonly statusCode: number | null;
  readonly durationMs: number | null;
  readonly attempt: number | null;
  readonly requestId: string | null;
}

interface ToolResultRecord extends RecordBase {
  readonly kind: 'tool_result';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly success: boolean | null;
  readonly durationMs: number | null;
  readonly errorType: string | null;
  readonly decisionSource: string | null;
}

interface ToolDecisionRecord extends RecordBase {
  readonly kind: 'tool_decision';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly decision: string | null;
  readonly source: string | null;
}

interface UserPromptRecord extends RecordBase {
  readonly kind: 'user_prompt';
  readonly promptLength: number | null;
  readonly promptId: string | null;
}

/** Any other Claude Code event, by its short name (for example "permission_mode_changed"). */
interface LogEventRecord extends RecordBase {
  readonly kind: 'event';
  readonly name: string;
}

interface SpanBase extends RecordBase {
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly parentSpanId: string | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
}

export interface LlmRequestSpanRecord extends SpanBase {
  readonly kind: 'llm_request';
  readonly requestId: string | null;
  readonly model: string | null;
  readonly ttftMs: number | null;
  readonly durationMs: number | null;
  readonly agentId: string | null;
  readonly parentAgentId: string | null;
  readonly success: boolean | null;
}

interface SpanRecord extends SpanBase {
  readonly kind: 'span';
  readonly name: string;
}

export type TelemetryRecord =
  | MetricPointRecord
  | ApiRequestRecord
  | ApiErrorRecord
  | ToolResultRecord
  | ToolDecisionRecord
  | UserPromptRecord
  | LogEventRecord
  | LlmRequestSpanRecord
  | SpanRecord;
