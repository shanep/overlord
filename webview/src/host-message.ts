// Guard for messages from the host. The host is trusted, but a stale panel
// or a version mismatch can still send something unexpected, so check the
// envelope and the top level shape of each view's state.

import type { HostToWebview, ViewId } from '../../src/shared/protocol.js';
import { isViewId } from '../../src/shared/protocol.js';

import { isArray, isNumber, isRecord } from './guards.js';

type FieldKind = 'array' | 'object' | 'number' | 'nullable-object';

const REQUIRED: Readonly<Record<ViewId, Readonly<Record<string, FieldKind>>>> = {
  fleet: {
    sessions: 'array',
    agents: 'array',
    pendingPermissions: 'array',
    places: 'object',
    projects: 'array',
    sessionProjects: 'object',
    rateLimits: 'object',
    spendPerHourUsd: 'number',
  },
  agent: {
    agent: 'nullable-object',
    session: 'nullable-object',
    children: 'array',
    feed: 'array',
    toolCalls: 'array',
    requests: 'array',
    compactions: 'array',
  },
  context: { snapshot: 'nullable-object', sessions: 'array' },
  knobs: { catalog: 'array', effective: 'array', profiles: 'array', featureFlags: 'object' },
  launcher: {
    runs: 'array',
    profiles: 'array',
    drafts: 'array',
    pendingPermissions: 'array',
    rules: 'array',
    maxConcurrency: 'number',
  },
  sessions: { sessions: 'array' },
  config: { items: 'array', repo: 'object' },
  usage: {
    days: 'array',
    hourCounts: 'object',
    totalSessions: 'number',
    totalMessages: 'number',
    plan: 'nullable-object',
  },
  reputation: {
    score: 'number',
    byDay: 'array',
    bySession: 'array',
    topKind: 'array',
    topMean: 'array',
    recent: 'array',
  },
  messages: { messages: 'array', routes: 'array', inboundChoices: 'array', rules: 'array' },
  properties: { session: 'nullable-object', agents: 'array', pendingPermissions: 'array' },
  help: {},
  tuning: { tips: 'array', suggestions: 'array', rows: 'array', sessions: 'number' },
};

function fieldMatches(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case 'array': {
      return isArray(value);
    }
    case 'object': {
      return isRecord(value);
    }
    case 'number': {
      return isNumber(value);
    }
    case 'nullable-object': {
      return value === null || isRecord(value);
    }
  }
}

function stateMatches(view: ViewId, state: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(REQUIRED[view]).every(([field, kind]) => fieldMatches(state[field], kind));
}

/** Narrow an unknown postMessage payload to a HostToWebview message. */
export function isHostToWebview(value: unknown): value is HostToWebview {
  if (!isRecord(value) || value['type'] !== 'state') {
    return false;
  }
  const view = value['view'];
  const state = value['state'];
  return isViewId(view) && isRecord(state) && stateMatches(view, state);
}
