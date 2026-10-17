// The fleet view: the store's sessions and agents with background jobs marked
// waiting or done, each session's project, the pending permissions from both
// sources, and rate limits as 0 to 1 fractions.

import path from 'node:path';

import { CLAUDE_CODE } from '../../../shared/agents.js';
import type { HealthLevel } from '../../../shared/health.js';
import type { PermissionRequest, SessionPlace, SessionSummary } from '../../../shared/model.js';
import { sessionName, ZERO_USAGE } from '../../../shared/model.js';
import type { FleetState, PlanLimits, RateLimits } from '../../../shared/protocol.js';
import { assessHealth } from '../../health/health.js';
import type { OverlordStore } from '../../store/store.js';
import type { BackgroundJob } from '../../surfaces/jobs.js';
import type { RegistryStatus } from '../places.js';
import type { ProjectView, SessionFolder } from '../projects.js';
import type { Runtime } from '../runtime.js';

import { currentPlan } from './usage.js';

/** The harness reports fractions; anything over 1 is a percentage and gets scaled down. */
export function toFraction(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return value > 1 ? value / 100 : value;
}

export function normalizeRateLimits(limits: RateLimits): RateLimits {
  return {
    fiveHourPct: toFraction(limits.fiveHourPct),
    sevenDayPct: toFraction(limits.sevenDayPct),
    resetsAt: limits.resetsAt,
  };
}

/**
 * Prefer the plan limits /usage shows. Rate limit events only come from
 * sessions Overlord launched and carry no time, so they fill in only what the
 * plan does not report.
 */
export function withPlanLimits(limits: RateLimits, plan: PlanLimits | null): RateLimits {
  const session = plan?.limits.find((limit) => limit.kind === 'session');
  const week = plan?.limits.find((limit) => limit.kind === 'weekly_all');
  return {
    fiveHourPct: session === undefined ? limits.fiveHourPct : session.percent / 100,
    sevenDayPct: week === undefined ? limits.sevenDayPct : week.percent / 100,
    resetsAt: session === undefined ? limits.resetsAt : session.resetsAt,
  };
}

/** What the fleet calls a session that has not had its first prompt, so Claude Code has not named it. */
export const NEW_SESSION_TITLE = 'New session';

/**
 * A row for a job with no transcript, from what Claude Code knows: one whose
 * transcript is gone, or a new one that has not had a prompt yet.
 */
function jobSession(job: BackgroundJob): SessionSummary {
  const startedAt = job.startedAt ?? 0;
  return {
    id: job.sessionId,
    agent: CLAUDE_CODE,
    surface: 'cli',
    title: job.name ?? NEW_SESSION_TITLE,
    cwd: job.cwd ?? '',
    state: job.state,
    startedAt,
    updatedAt: startedAt,
    usage: ZERO_USAGE,
    costUsd: null,
    model: null,
    effort: null,
    permissionMode: null,
    pid: null,
    transcriptPath: null,
    gitBranch: null,
    version: null,
    agentCount: 0,
    contextFill: null,
    recap: null,
    lastPrompt: null,
    lastPromptAt: null,
  };
}

/**
 * A transcript cannot tell a job waiting on the user or a finished one from
 * an idle session, so Claude Code's job state wins. A waiting or failed job
 * with no transcript still gets a row. A finished one does not: it either
 * never got a prompt or aged out of the fleet, so there is nothing to show.
 */
export function withJobStates(
  sessions: readonly SessionSummary[],
  jobs: readonly BackgroundJob[],
): readonly SessionSummary[] {
  if (jobs.length === 0) {
    return sessions;
  }
  const byId = new Map(jobs.map((job) => [job.sessionId, job]));
  const marked = sessions.map((session) => {
    const job = byId.get(session.id);
    return job === undefined || job.state === session.state
      ? session
      : { ...session, state: job.state };
  });
  const known = new Set(sessions.map((session) => session.id));
  const bare = jobs
    .filter((job) => job.state !== 'done' && !known.has(job.sessionId))
    .map((job) => jobSession(job));
  return [...marked, ...bare];
}

/**
 * A transcript lags the session: it says nothing while a permission prompt
 * waits, and a job's state is only as fresh as the last `claude agents` call.
 * So a pending permission or Claude Code's own waiting means waiting, its
 * busy means running, and its idle ends a running state the transcript has
 * not ended yet.
 */
export function withLiveStates(
  sessions: readonly SessionSummary[],
  statuses: Readonly<Record<string, RegistryStatus>>,
  pending: readonly PermissionRequest[],
): readonly SessionSummary[] {
  const asking = new Set(pending.map((request) => request.sessionId));
  return sessions.map((session) => {
    const status = statuses[session.id];
    let { state } = session;
    if (asking.has(session.id) || status === 'waiting') {
      state = 'waiting';
    } else if (status === 'busy') {
      state = 'running';
    } else if (status === 'idle' && state === 'running') {
      state = 'idle';
    }
    return state === session.state ? session : { ...session, state };
  });
}

export interface FleetInputs {
  readonly store: OverlordStore;
  readonly pending: readonly PermissionRequest[];
  readonly now: number;
  readonly plan: PlanLimits | null;
  readonly places: Readonly<Record<string, SessionPlace>>;
  /** The session in the focused terminal, when Overlord knows it. */
  readonly activeSessionId: string | null;
  readonly activeVersion: number;
  /** This window's workspace folder, whose session is highlighted when no terminal says otherwise. */
  readonly workspaceFolder: string | null;
  /** Every folder in this window's workspace, whose projects stay listed with no sessions. */
  readonly workspaceFolders: readonly string[];
  readonly jobs: readonly BackgroundJob[];
  /** Busy, idle or waiting from Claude Code's session registry, by session id. */
  readonly statuses: Readonly<Record<string, RegistryStatus>>;
  /** The sessions the Launcher started. */
  readonly launched: readonly string[];
  /** The projects, and the project of each session and workspace folder that has been checked. */
  readonly projects: (
    sessions: readonly SessionFolder[],
    workspace: readonly string[],
  ) => ProjectView;
}

function newest(sessions: readonly SessionSummary[]): string | null {
  return sessions.toSorted((left, right) => right.updatedAt - left.updatedAt).at(0)?.id ?? null;
}

/**
 * The session that belongs to a window: the newest one that ran in its
 * folder, or else the newest one in a folder under it.
 */
export function windowSession(
  sessions: readonly SessionSummary[],
  folder: string | null,
): string | null {
  if (folder === null) {
    return null;
  }
  const root = folder.endsWith(path.sep) ? folder.slice(0, -1) : folder;
  return (
    newest(sessions.filter((session) => session.cwd === root)) ??
    newest(sessions.filter((session) => session.cwd.startsWith(root + path.sep)))
  );
}

/** Each unfinished session that is wearing out, with how badly. */
export function fleetHealth(
  store: OverlordStore,
  sessions: readonly SessionSummary[],
): FleetState['health'] {
  const activity = store.mainThreadActivity();
  const out: Record<string, Exclude<HealthLevel, 'good'>> = {};
  for (const session of sessions) {
    const thread = activity.get(session.id);
    if (thread === undefined || session.state === 'done' || session.state === 'failed') {
      continue;
    }
    const { level } = assessHealth({
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      ...thread,
    });
    if (level !== 'good') {
      out[session.id] = level;
    }
  }
  return out;
}

export function buildFleet(input: FleetInputs): FleetState {
  const base = input.store.fleetState(input.now);
  const sessions = withLiveStates(
    withJobStates(base.sessions, input.jobs),
    input.statuses,
    input.pending,
  );
  const projects = input.projects(sessions, input.workspaceFolders);
  return {
    sessions,
    agents: base.agents,
    pendingPermissions: input.pending,
    places: input.places,
    projects: projects.projects,
    sessionProjects: projects.sessionProjects,
    workspaceProjects: projects.workspaceProjects,
    activeSessionId: input.activeSessionId ?? windowSession(sessions, input.workspaceFolder),
    activeVersion: input.activeVersion,
    rateLimits: withPlanLimits(normalizeRateLimits(base.rateLimits), input.plan),
    spendPerHourUsd: base.spendPerHourUsd,
    health: fleetHealth(input.store, sessions),
    launched: input.launched,
  };
}

export function fleetFor(rt: Runtime): FleetState {
  return buildFleet({
    store: rt.store,
    pending: rt.permissions.list(),
    now: rt.clock(),
    plan: currentPlan(rt),
    places: rt.places.value,
    activeSessionId: rt.places.activeSession(),
    activeVersion: rt.places.activeVersion,
    workspaceFolder: rt.host.workspaceFolder(),
    workspaceFolders: rt.host.workspaceFolders(),
    jobs: rt.jobs.value,
    statuses: rt.places.statuses,
    launched: rt.launched.list(),
    projects: (sessions, workspace) => rt.projects.view(sessions, workspace),
  });
}

/** The name the fleet shows for a session, or null when the fleet does not list it. */
export function fleetSessionName(rt: Runtime, sessionId: string): string | null {
  const session = fleetFor(rt).sessions.find((candidate) => candidate.id === sessionId);
  return session === undefined ? null : sessionName(session);
}
