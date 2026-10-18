// Fleet header stats and the pending permissions banner.

import type { ReactElement } from 'react';

import type { AgentInfo } from '../../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../../src/shared/agents.js';
import {
  permissionChoices,
  type PermissionChoice,
  type PermissionRequest,
  type SessionSummary,
} from '../../../src/shared/model.js';
import type { FleetState } from '../../../src/shared/protocol.js';
import { findAgent, knownAgents, knowsClaude, useAgents } from '../agents.js';
import { AgentLogo, Badge } from '../components/badge.js';
import { Meter } from '../components/meter.js';
import { formatDuration, formatValue, truncate } from '../format.js';
import type { Tone } from '../labels.js';

import { normalizeRatio } from './fleet-rows.js';
import { otherWindows } from './limit-windows.js';

function Stat(props: {
  readonly label: string;
  readonly tone?: Tone;
  /** The agent the number belongs to, drawn as its logo before the label and named in its tooltip. */
  readonly agent?: AgentInfo;
  /** Time until the limit resets, in small text under the value. */
  readonly detail?: string | null;
  readonly children: ReactElement | string;
}): ReactElement {
  return (
    <div className={`stat stat-${props.tone ?? 'neutral'}`}>
      <dt data-tip={props.agent === undefined ? undefined : `${props.agent.name} ${props.label}`}>
        {props.agent === undefined ? null : <AgentLogo agent={props.agent} />}
        {props.label}
      </dt>
      <dd>{props.children}</dd>
      {props.detail === undefined || props.detail === null ? null : (
        <dd className="stat-detail" data-tip={`Resets in ${props.detail}`}>
          {props.detail}
        </dd>
      )}
    </div>
  );
}

/** Time left until a limit resets, such as "1h 30m", or null when unknown or already past. */
function resetsIn(resetsAt: number | null, now: number): string | null {
  return resetsAt === null || resetsAt <= now ? null : formatDuration(resetsAt - now);
}

export function FleetHeader(props: {
  readonly state: FleetState;
  readonly now: number;
}): ReactElement {
  const { state, now } = props;
  const agents = useAgents();
  const known = knownAgents(agents);
  const anySubagents = known.some((agent) => agent.capabilities.subagents);
  // The 5 hour and 7 day windows are Claude Code's plan limits.
  const claudeLimits = knowsClaude(agents);
  const count = (wanted: string): number =>
    state.sessions.filter((session) => session.state === wanted).length;
  const subagents = state.agents.filter(
    (agent) => agent.id !== agent.sessionId && agent.state === 'running',
  ).length;
  const waiting = count('waiting');
  const unplaced = state.sessions.filter((session) => {
    const project = state.sessionProjects[session.id];
    return (
      project?.projectId === null &&
      !project.ignored &&
      session.state !== 'done' &&
      session.state !== 'failed'
    );
  }).length;
  const { fiveHourPct, sevenDayPct, resetsAt, windows } = state.rateLimits;
  const claude = findAgent(agents, CLAUDE_CODE);
  const sevenDayResetsAt =
    windows?.find((window) => window.agent === CLAUDE_CODE && window.id === 'seven_day')
      ?.resetsAt ?? null;
  return (
    <header className="fleet-header">
      <h1>Fleet</h1>
      <dl className="stat-tiles">
        <Stat label="Running">{`${count('running').toString()} of ${state.sessions.length.toString()}`}</Stat>
        <Stat label="Waiting" tone={waiting > 0 ? 'warning' : 'neutral'}>
          {waiting.toString()}
        </Stat>
        {unplaced === 0 ? null : (
          <Stat label="No project" tone="warning">
            {unplaced.toString()}
          </Stat>
        )}
        {anySubagents ? <Stat label="Subagents">{`${subagents.toString()} running`}</Stat> : null}
        {claudeLimits ? (
          <Stat label="5 hour limit" agent={claude} detail={resetsIn(resetsAt, now)}>
            <Meter label="5 hour limit used" ratio={normalizeRatio(fiveHourPct)} />
          </Stat>
        ) : null}
        {!claudeLimits || sevenDayPct === null ? null : (
          <Stat label="7 day limit" agent={claude} detail={resetsIn(sevenDayResetsAt, now)}>
            <Meter label="7 day limit used" ratio={normalizeRatio(sevenDayPct)} />
          </Stat>
        )}
        {otherWindows(windows, agents, now).map(({ key, label, title, agent, window }) => (
          <Stat key={key} label={title} agent={agent} detail={resetsIn(window.resetsAt, now)}>
            <Meter label={`${label} used`} ratio={window.usedPct} />
          </Stat>
        ))}
      </dl>
    </header>
  );
}

/** A banner button: one of the request's choices, or Always allow, which adds a rule. */
export type BannerChoice = PermissionChoice | 'always';

const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'PowerShell',
  'bash',
  'execute',
  'exec_command',
]);

/**
 * What an Always allow rule for this tool covers, for the button's tooltip.
 * The rule answers only the agent that asked, so the tip names it.
 */
export function alwaysAllowScope(toolName: string, agentShort: string): string {
  const where = `in every ${agentShort} session`;
  return SHELL_TOOLS.has(toolName)
    ? `Allow this exact command from now on, ${where}`
    : `Allow every ${toolName} request from now on, ${where}`;
}

/** True when the request takes this answer. */
export function offers(request: PermissionRequest, choice: PermissionChoice): boolean {
  return permissionChoices(request).includes(choice);
}

export function PermissionBanner(props: {
  readonly requests: readonly PermissionRequest[];
  readonly sessions: readonly SessionSummary[];
  readonly onResolve: (request: PermissionRequest, choice: BannerChoice) => void;
}): ReactElement {
  const { requests, sessions, onResolve } = props;
  const agents = useAgents();
  const titleOf = (sessionId: string): string =>
    sessions.find((session) => session.id === sessionId)?.title ?? sessionId;
  const noun = requests.length === 1 ? 'permission' : 'permissions';
  return (
    <section className="banner" aria-label="Pending permissions">
      <strong>{`${requests.length.toString()} pending ${noun}`}</strong>
      <ul>
        {requests.map((request) => {
          const title = titleOf(request.sessionId);
          return (
            <li key={request.id}>
              <Badge label={request.toolName} tone="warning" />
              <span className="permission-title">{title}</span>
              <code className="permission-input">{truncate(formatValue(request.input), 80)}</code>
              <span className="permission-buttons">
                <button
                  type="button"
                  className="primary"
                  data-tip="Let this one call run"
                  aria-label={`Allow ${request.toolName} for ${title}`}
                  onClick={() => {
                    onResolve(request, 'allow');
                  }}
                >
                  Allow
                </button>
                <button
                  type="button"
                  data-tip={alwaysAllowScope(
                    request.toolName,
                    findAgent(agents, request.agent).short,
                  )}
                  aria-label={`Always allow ${request.toolName} for ${title}`}
                  onClick={() => {
                    onResolve(request, 'always');
                  }}
                >
                  Always allow
                </button>
                <button
                  type="button"
                  data-tip="Block this call and tell the session it was denied"
                  aria-label={`Deny ${request.toolName} for ${title}`}
                  onClick={() => {
                    onResolve(request, 'deny');
                  }}
                >
                  Deny
                </button>
                {offers(request, 'allow_session') ? (
                  <button
                    type="button"
                    data-tip="Let this call run and let the agent skip asking again in this session"
                    aria-label={`Allow ${request.toolName} for the rest of ${title}`}
                    onClick={() => {
                      onResolve(request, 'allow_session');
                    }}
                  >
                    Allow for session
                  </button>
                ) : null}
                {offers(request, 'cancel') ? (
                  <button
                    type="button"
                    data-tip="Block this call and stop the current turn"
                    aria-label={`Deny ${request.toolName} and stop ${title}`}
                    onClick={() => {
                      onResolve(request, 'cancel');
                    }}
                  >
                    Stop turn
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
