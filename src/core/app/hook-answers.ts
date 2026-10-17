// What the hook server answers from: the coordinator, the launch check and
// the connector briefing. The same three make the notes a session gets at
// launch when its agent takes them that way, so a session that got them at
// launch is not told again by its SessionStart hook.

import { agents } from '../agents/index.js';
import type { Coordinator } from '../coordination/coordinator.js';
import type { HookAnswer, HookEventOf, NormalizedHookEvent } from '../hooks/normalized.js';
import { withContextNote, withNotice } from '../hooks/normalized.js';
import type { LaunchChecker } from '../launch-check/checker.js';
import { compatSummary } from '../launch-check/note.js';

import { telemetryConfig } from './agent-talk.js';
import type { LaunchNotes } from './launch-notes.js';
import type { Runtime } from './runtime.js';
import { sessionBriefing } from './views/connectors.js';

export interface HookAnswerSources {
  readonly coordinator: Coordinator;
  readonly launchCheck: LaunchChecker;
  readonly notes: LaunchNotes;
  /** The OTLP receiver's port, or null when it is not running. */
  readonly telemetryPort: () => number | null;
}

export interface HookAnswerers {
  readonly advise: (event: NormalizedHookEvent) => HookAnswer | null;
  readonly sessionContext: (event: HookEventOf<'session-start'>) => string | null;
}

/** Connects the launch notes to their sources and returns the hook server's answerers. */
export function hookAnswers(rt: Runtime, sources: HookAnswerSources): HookAnswerers {
  const { coordinator, launchCheck, notes } = sources;
  const briefing = (event: { readonly agent: string }): string | null =>
    rt.host.settings.briefSessions ? sessionBriefing(rt, event.agent) : null;
  notes.connect({
    briefing: (agent) => briefing({ agent }),
    launchCheck: async (cwd, agent, waitMs) => launchCheck.noteAt(cwd, agent, waitMs),
    peers: (cwd) => coordinator.startNote(cwd),
    telemetry: async (agent) =>
      telemetryConfig(
        { registry: agents, paths: rt.paths, env: rt.env, port: sources.telemetryPort() },
        agent,
      ),
    now: rt.clock,
  });
  return {
    advise: (event): HookAnswer | null => {
      // The coordinator sees every event, so it keeps track of the session either way.
      const advice = coordinator.handle(event);
      if (notes.isCovered(event)) {
        return null;
      }
      const note = launchCheck.noteFor(event);
      return withNotice(withContextNote(advice, note), note === null ? null : compatSummary(note));
    },
    sessionContext: (event) => (notes.isCovered(event) ? null : briefing(event)),
  };
}
