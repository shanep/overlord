// What a session Overlord starts itself gets at launch, for an agent that
// takes it there instead of from a hook (Codex, see its inject and telemetry
// facets): Overlord's notes, and its telemetry export while the receiver
// runs. The notes are what a SessionStart hook would add: the connector
// briefing, the launch check and who else works in the repository. When that
// agent's hooks do run too, its SessionStart hook leaves them out, so the
// session does not hear them twice.

import type { AgentId } from '../../shared/agents.js';
import { agents } from '../agents/index.js';
import type { InjectFacet } from '../agents/talk-types.js';
import { injectRoute } from '../agents/talk-types.js';
import type { NormalizedHookEvent } from '../hooks/normalized.js';
import type { ConfigOverride } from '../knobs/facet.js';
import { configArgs } from '../knobs/launch.js';

/** How long a launch waits for a launch check that is still running. */
const LAUNCH_CHECK_WAIT_MS = 5000;

/**
 * A session given its notes at launch has this long to send its SessionStart
 * hook. Until then, another session of the same agent that starts in the same
 * folder in that time is taken for it and gets no notes from its hook. Tabs
 * give no session id up front, so the folder is all there is to go on.
 */
export const COVER_MS = 2 * 60_000;

export interface LaunchNoteSources {
  /** The connector briefing for the agent's sessions, or null when briefings are off. */
  readonly briefing: (agent: AgentId) => string | null;
  /** The launch check note for cwd, waiting up to waitMs for a check to finish. */
  readonly launchCheck: (cwd: string, agent: AgentId, waitMs: number) => Promise<string | null>;
  /** Who else works in cwd's repository, or null. */
  readonly peers: (cwd: string) => string | null;
  /** Overrides that send the launch's telemetry to Overlord's receiver, or none. */
  readonly telemetry: (agent: AgentId) => Promise<readonly ConfigOverride[]>;
  readonly now: () => number;
}

function keyOf(agent: AgentId, cwd: string): string {
  return `${agent}\n${cwd}`;
}

/** The inject facet of an agent whose sessions take Overlord's notes at launch, else null. */
function launchFacet(agent: AgentId): InjectFacet | null {
  const facet = agents.get(agent)?.inject;
  if (facet === undefined) {
    return null;
  }
  // An agent that does not say otherwise counts on its hooks, as Claude Code does.
  const route = injectRoute(facet, { hooks: facet.launchFirst !== true, launching: true });
  return route === 'launch-argument' ? facet : null;
}

/** True when a launch of the agent can carry its telemetry export. */
function takesTelemetry(agent: AgentId): boolean {
  return agents.get(agent)?.telemetry?.launchConfig !== undefined;
}

export class LaunchNotes {
  private sources: LaunchNoteSources | null = null;
  /** Folders a session was just started in with its notes, by agent, until when. */
  private readonly given = new Map<string, number>();
  /** Sessions whose SessionStart hook matched a launch, so later questions about them agree. */
  private readonly covered = new Set<string>();

  /** The sources exist only once the app is built, so they come in after construction. */
  connect(sources: LaunchNoteSources): void {
    this.sources = sources;
  }

  /**
   * Config overrides for a Launcher run of agent in cwd: its notes and its
   * telemetry. Null, with nothing to wait for, for an agent that takes
   * neither at launch, so its runs start as they always did.
   */
  readonly config = (agent: AgentId, cwd: string): Promise<readonly ConfigOverride[]> | null => {
    const make = launchFacet(agent)?.launchConfig;
    if (make === undefined && !takesTelemetry(agent)) {
      return null;
    }
    return (async (): Promise<readonly ConfigOverride[]> => {
      const text = make === undefined ? null : await this.text(agent, cwd);
      const notes = make === undefined || text === null ? [] : make(text);
      return [...notes, ...((await this.sources?.telemetry(agent)) ?? [])];
    })();
  };

  /** Arguments for a tab that starts a session of agent in cwd, the way config gives them. */
  readonly args = (agent: AgentId, cwd: string): Promise<readonly string[]> | null => {
    const make = launchFacet(agent)?.launchArgs;
    if (make === undefined && !takesTelemetry(agent)) {
      return null;
    }
    return (async (): Promise<readonly string[]> => {
      const text = make === undefined ? null : await this.text(agent, cwd);
      const notes = make === undefined || text === null ? [] : make(text);
      const telemetry = (await this.sources?.telemetry(agent)) ?? [];
      return [...notes, ...configArgs(telemetry)];
    })();
  };

  /**
   * True when a session-start hook comes from a session that got its notes at
   * launch, so the hook answer leaves them out. Any other event is false.
   */
  isCovered(event: NormalizedHookEvent): boolean {
    if (event.kind !== 'session-start') {
      return false;
    }
    if (this.covered.has(event.sessionId)) {
      return true;
    }
    const key = keyOf(event.agent, event.cwd ?? '');
    const until = this.given.get(key);
    const now = this.sources?.now() ?? 0;
    this.given.delete(key);
    if (until === undefined || until < now) {
      return false;
    }
    this.covered.add(event.sessionId);
    return true;
  }

  private async text(agent: AgentId, cwd: string): Promise<string | null> {
    const { sources } = this;
    if (sources === null) {
      return null;
    }
    const check = await sources.launchCheck(cwd, agent, LAUNCH_CHECK_WAIT_MS);
    const notes = [sources.briefing(agent), check, sources.peers(cwd)].filter(
      (note): note is string => note !== null && note !== '',
    );
    if (notes.length === 0) {
      return null;
    }
    this.given.set(keyOf(agent, cwd), sources.now() + COVER_MS);
    return notes.join('\n\n');
  }
}
