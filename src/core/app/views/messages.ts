// The agent messages view: messages between agents and sessions from the
// transcripts, the crossSessionInbound setting in effect, and the rules that
// can block SendMessage. Reads are synchronous from a per-runtime cache that
// refreshes in the background once it is older than STALE_MS.

import type { AutoApproveRule, MessagesState } from '../../../shared/protocol.js';
import { SEND_MESSAGE_TOOL, toolPatternMatches } from '../../hooks/rules.js';
import { loadCatalog } from '../../knobs/catalog.js';
import { loadLayers } from '../../knobs/layers.js';
import { effectiveInbound, inboundChoices } from '../../messaging/inbound.js';
import { MessageIndex } from '../../messaging/index.js';
import { messageOf } from '../errors.js';
import type { Runtime } from '../runtime.js';

export const EMPTY_MESSAGES: MessagesState = {
  messages: [],
  routes: [],
  inboundPolicy: null,
  inboundChoices: [],
  rules: [],
};

export const STALE_MS = 30_000;

const SOURCE = 'messages';

interface MessagesCache {
  readonly index: MessageIndex;
  state: MessagesState;
  loadedAt: number | null;
  running: Promise<void> | null;
}

const caches = new WeakMap<Runtime, MessagesCache>();

function cacheFor(rt: Runtime): MessagesCache {
  let cache = caches.get(rt);
  if (cache === undefined) {
    cache = {
      index: new MessageIndex({ projectsDir: rt.paths.projectsDir }),
      state: { ...EMPTY_MESSAGES, inboundChoices: inboundChoices(loadCatalog()) },
      loadedAt: null,
      running: null,
    };
    caches.set(rt, cache);
  }
  return cache;
}

/** Rules whose tool pattern covers SendMessage, enabled or not. */
export function sendMessageRules(rules: readonly AutoApproveRule[]): readonly AutoApproveRule[] {
  return rules.filter((rule) => toolPatternMatches(rule.tool, SEND_MESSAGE_TOOL));
}

async function load(rt: Runtime, cache: MessagesCache): Promise<void> {
  try {
    const [scan, layers] = await Promise.all([
      cache.index.scan(),
      loadLayers({ paths: rt.paths, projectDir: rt.host.workspaceFolder(), env: rt.env }),
    ]);
    cache.state = {
      ...cache.state,
      messages: scan.messages,
      routes: scan.routes,
      inboundPolicy: effectiveInbound(layers),
    };
  } catch (error) {
    rt.report(SOURCE, messageOf(error));
  }
  cache.loadedAt = rt.clock();
  rt.notify();
}

/** Rescans now, after any scan already running, and tells the panels. */
export async function refreshMessages(rt: Runtime): Promise<void> {
  const cache = cacheFor(rt);
  if (cache.running !== null) {
    await cache.running;
  }
  const run = load(rt, cache);
  cache.running = run;
  await run;
  if (cache.running === run) {
    cache.running = null;
  }
}

function isStale(cache: MessagesCache, now: number): boolean {
  return cache.running === null && (cache.loadedAt === null || now - cache.loadedAt >= STALE_MS);
}

export function buildMessages(rt: Runtime): MessagesState {
  const cache = cacheFor(rt);
  if (isStale(cache, rt.clock())) {
    void refreshMessages(rt);
  }
  return { ...cache.state, rules: sendMessageRules(rt.permissions.rules()) };
}

/** The last loaded state, without starting a scan. For tests and actions. */
export function cachedMessages(rt: Runtime): MessagesState {
  return cacheFor(rt).state;
}
