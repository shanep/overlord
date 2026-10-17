// Folds the deltas from one read of a session's files into one batch for the
// bus: the last version of each tool and request, feed items in order, and
// the newest rate limit report.

import type { ApiRequest, FeedItem, ToolCall } from '../../../shared/model.js';
import type { RateLimitReport, RecordDelta } from '../types.js';

interface Batch {
  readonly tools: Map<string, ToolCall>;
  readonly requests: Map<string, ApiRequest>;
  readonly feed: Map<string, FeedItem[]>;
  readonly contexts: Set<string>;
  readonly compactions: { readonly agentId: string; readonly at: number }[];
  /** The newest rate limit report in the batch. */
  rateLimits: RateLimitReport | null;
}

/** Merge per-record results: the last version of each tool and request wins, feed items keep order. */
export function collectBatch(results: readonly RecordDelta[]): Batch {
  const batch: Batch = {
    tools: new Map(),
    requests: new Map(),
    feed: new Map(),
    contexts: new Set(),
    compactions: [],
    rateLimits: null,
  };
  for (const result of results) {
    for (const tool of result.tools) {
      batch.tools.set(tool.id, tool);
    }
    for (const request of result.requests) {
      batch.requests.set(request.messageId, request);
    }
    if (result.feed.length > 0) {
      const items = batch.feed.get(result.agentId) ?? [];
      items.push(...result.feed);
      batch.feed.set(result.agentId, items);
    }
    if (result.contextChanged) {
      batch.contexts.add(result.agentId);
    }
    for (const at of result.compactions) {
      batch.compactions.push({ agentId: result.agentId, at });
    }
    const limits = result.rateLimits;
    if (limits !== undefined && (batch.rateLimits === null || limits.at >= batch.rateLimits.at)) {
      batch.rateLimits = limits;
    }
  }
  return batch;
}
