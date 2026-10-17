import type { ReactElement } from 'react';

import type { AgentInfo } from '../../../src/shared/agents.js';
import type { Backend } from '../../../src/shared/backends.js';
import type { SessionPlace, SessionState, Surface } from '../../../src/shared/model.js';
import boisestateLogo from '../assets/boisestate.png';
import clawdLogo from '../assets/clawd.svg';
import type { Tone } from '../labels.js';
import {
  LAUNCHED_INFO,
  PLACE_INFO,
  STATE_INFO,
  SURFACE_LABELS,
  WINDOWLESS_INFO,
} from '../labels.js';

import { agentIcon, Icon } from './icon.js';

export function Badge(props: {
  readonly label: string;
  readonly tone?: Tone;
  readonly title?: string;
}): ReactElement {
  return (
    <span className={`badge badge-${props.tone ?? 'neutral'}`} data-tip={props.title}>
      {props.label}
    </span>
  );
}

/** Session or agent state as a glyph plus a word, colored by tone. Hover explains it. */
export function StateBadge(props: { readonly state: SessionState }): ReactElement {
  const info = STATE_INFO[props.state];
  return (
    <span className={`state state-${info.tone}`} data-tip={`${info.label}: ${info.description}`}>
      <span aria-hidden="true" className="state-icon">
        {info.icon}
      </span>
      <span className="state-label">{info.label}</span>
    </span>
  );
}

export function SurfaceBadge(props: { readonly surface: Surface }): ReactElement {
  return <Badge label={SURFACE_LABELS[props.surface]} tone="info" />;
}

/** Where a live session runs, as an icon. Hovering or a screen reader gives the words. */
export function PlaceMarker(props: { readonly place: SessionPlace }): ReactElement {
  const info = PLACE_INFO[props.place];
  return (
    <span
      className={`place place-${info.tone}`}
      role="img"
      aria-label={info.label}
      data-tip={`${info.label}: ${info.description}`}
    >
      <Icon name={info.icon} />
    </span>
  );
}

/** A quiet session no terminal shows, which leaves the fleet in time. */
export function WindowlessMarker(): ReactElement {
  return (
    <span
      className="place place-neutral"
      role="img"
      aria-label={WINDOWLESS_INFO.label}
      data-tip={`${WINDOWLESS_INFO.label}: ${WINDOWLESS_INFO.description}`}
    >
      <Icon name="hourglass" />
    </span>
  );
}

/** A session started from the Launcher, which Overlord runs itself. */
export function LaunchedMarker(): ReactElement {
  return (
    <span
      className="place place-launched"
      role="img"
      aria-label={LAUNCHED_INFO.label}
      data-tip={`${LAUNCHED_INFO.label}: ${LAUNCHED_INFO.description}`}
    >
      <Icon name="launched" />
    </span>
  );
}

const BACKENDS: Readonly<Record<Backend, { readonly logo: string; readonly name: string }>> = {
  anthropic: { logo: clawdLogo, name: 'Anthropic' },
  boisestate: { logo: boisestateLogo, name: 'boisestate.ai' },
};

/** Clawd for a session on Anthropic, the Boise State B for one on the boisestate.ai bridge. */
function BackendLogo(props: { readonly backend: Backend }): ReactElement {
  return <img className="backend-logo" src={BACKENDS[props.backend].logo} alt="" />;
}

/** The backend a Claude Code session talks to, as its logo alone. */
export function BackendMark(props: { readonly backend: Backend }): ReactElement {
  return (
    <span className="backend-mark" data-tip={`Backend: ${BACKENDS[props.backend].name}`}>
      <BackendLogo backend={props.backend} />
    </span>
  );
}

/**
 * The agent CLI behind a session: its icon and short name, quiet so the title
 * still leads. A known backend shows its logo in place of the agent's icon.
 */
export function AgentMark(props: {
  readonly agent: AgentInfo;
  readonly backend?: Backend | null;
}): ReactElement {
  const { agent, backend = null } = props;
  const version = agent.version === null ? '' : ` ${agent.version}`;
  const on = backend === null ? '' : ` on ${BACKENDS[backend].name}`;
  return (
    <span className="agent-mark" data-tip={`Agent: ${agent.name}${version}${on}`}>
      {backend === null ? <Icon name={agentIcon(agent.icon)} /> : <BackendLogo backend={backend} />}
      <span className="agent-mark-name">{agent.short}</span>
    </span>
  );
}
