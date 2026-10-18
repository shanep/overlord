// The Fleet's New session menu, for when more than one agent is installed:
// one button per agent, each starting a session the way the sparkle does.
// With one agent it renders nothing, since the sparkle already starts it.

import type { ReactElement } from 'react';
import { useId, useRef, useState } from 'react';

import type { AgentInfo } from '../../../src/shared/agents.js';
import { agentIcon, Icon } from '../components/icon.js';
import { usePostAction } from '../vscode-context.js';

import { useMenuDismiss } from './fleet-view-menu.js';

export function NewSessionMenu(props: {
  readonly agents: readonly AgentInfo[];
}): ReactElement | null {
  const post = usePostAction();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const onPointerDown = useMenuDismiss(open, setOpen, button);
  if (props.agents.length < 2) {
    return null;
  }
  return (
    <div className="view-menu" onPointerDown={onPointerDown}>
      <button
        type="button"
        ref={button}
        className="view-menu-button"
        aria-expanded={open}
        aria-controls={panelId}
        data-tip="Start a new session with the agent you pick, in its own worktree"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="newSession" />
        <span className="toolbar-label">New session</span>
      </button>
      {open ? (
        <div
          id={panelId}
          className="view-menu-panel view-menu-panel-start"
          role="group"
          aria-label="New session"
        >
          {props.agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                post({ type: 'newSession', agent: agent.id });
              }}
            >
              <Icon name={agentIcon(agent)} />
              {agent.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
