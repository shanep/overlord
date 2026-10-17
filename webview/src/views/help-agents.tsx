// The "Agents" part of the help page: which agent CLIs Overlord knows, what
// works for each one, and a few lines per agent on where Overlord reads it
// and how its sessions start. The table and every paragraph that depends on
// what an agent can do read its capabilities, so the page follows the
// adapters as they grow instead of promising what is planned.

import type { ReactElement } from 'react';

import type { AgentCapabilities, AgentInfo } from '../../../src/shared/agents.js';
import { CLAUDE_CODE, CODEX, COPILOT } from '../../../src/shared/agents.js';
import { knownAgents, useAgents } from '../agents.js';

/** The id of the Claude Code session diagrams, which the Claude section links to. */
export const CLAUDE_SESSIONS_ID = 'help-sessions';

interface Feature {
  readonly name: string;
  readonly has: (can: AgentCapabilities) => boolean;
}

/** One row per thing an agent may or may not support, in the order people meet them. */
export const FEATURES: readonly Feature[] = [
  // Every agent's sessions reach the Fleet, from its transcripts or from the Launcher.
  { name: 'Sessions in the Fleet', has: () => true },
  { name: 'New session in a terminal tab', has: (can) => can.terminal },
  { name: 'Continue an old session', has: (can) => can.resume },
  { name: 'Fork a session', has: (can) => can.fork },
  { name: 'Background jobs', has: (can) => can.background },
  { name: 'Launcher runs', has: (can) => can.launch },
  { name: 'Permission inbox', has: (can) => can.approvals },
  { name: 'Interrupt', has: (can) => can.interrupt },
  {
    name: 'Change model or mode mid run',
    has: (can) => can.liveModelChange || can.livePermissionMode,
  },
  { name: 'Subagents', has: (can) => can.subagents },
  { name: 'Cache share', has: (can) => can.cacheReads },
  { name: 'Cost', has: (can) => can.costUsd },
  { name: 'Context Inspector', has: (can) => can.contextInspector },
  { name: 'Hooks and coordination notes', has: (can) => can.hooks },
  { name: 'Agent Messages', has: (can) => can.messaging },
  { name: 'Handoffs in All Sessions', has: (can) => can.handoffs.length > 0 },
];

function Works(props: { readonly yes: boolean }): ReactElement {
  return props.yes ? <span>Yes</span> : <span className="muted">No</span>;
}

function FeatureTable(props: { readonly agents: readonly AgentInfo[] }): ReactElement {
  const { agents } = props;
  return (
    <table className="grid help-table" aria-label="What works for each agent">
      <thead>
        <tr>
          <th scope="col">Feature</th>
          {agents.map((agent) => (
            <th key={agent.id} scope="col">
              {agent.short}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {FEATURES.map((feature) => (
          <tr key={feature.name}>
            <td className="help-key">{feature.name}</td>
            {agents.map((agent) => (
              <td key={agent.id}>
                <Works yes={feature.has(agent.capabilities)} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ClaudeNotes(props: { readonly can: AgentCapabilities }): ReactElement {
  const { can } = props;
  return (
    <>
      <p>
        Overlord reads Claude Code sessions from the transcripts in ~/.claude/projects, and runs
        Launcher prompts through the Agent SDK.
      </p>
      {can.background ? (
        <p>
          A session from the sparkle or Continue runs as a background job (<code>claude --bg</code>
          ), and its editor tab runs <code>claude attach &lt;id&gt;</code>. Overlord finds the job
          with <code>claude agents</code>, and closing the tab of a session with nothing left to do
          runs <code>claude stop</code>, which keeps the conversation.{' '}
          <a href={`#${CLAUDE_SESSIONS_ID}`}>How a Claude Code session works</a> draws each step.
        </p>
      ) : null}
      {can.handoffs.includes('open-desktop') ? (
        <p>
          All Sessions also lists the Code tab in Claude Desktop, Cowork and Claude Code on the web.
          Its handoff buttons open a session in Desktop, pull a cloud session down to this machine,
          or resume one with Remote Control. Run &quot;Overlord: Import claude.ai Export&quot; to
          add your claude.ai chats.
        </p>
      ) : null}
      {can.hooks ? (
        <p>
          &quot;Overlord: Set Up Hooks and Telemetry&quot; writes to ~/.claude/settings.json, so
          permission requests reach the inbox, sessions in one repo hear about each other, and the
          Fleet gets cost per request.
        </p>
      ) : null}
    </>
  );
}

/** Where Overlord reads each agent's sessions. An agent with no entry gets none. */
const READS: Readonly<Record<string, string>> = {
  [CODEX]:
    'Overlord reads Codex sessions from the rollout files in ~/.codex/sessions, so a codex you start anywhere shows up in the Fleet. Codex reports cached input but no cost, since a ChatGPT plan bills by limits, not tokens.',
  [COPILOT]:
    'Overlord reads Copilot sessions from ~/.copilot/session-state, so a copilot you start anywhere shows up in the Fleet. Copilot reports what each session cost, so its Cost column is its own figure, not a list price estimate.',
};

function OtherNotes(props: { readonly agent: AgentInfo }): ReactElement {
  const { agent } = props;
  const reads = READS[agent.id];
  const can = agent.capabilities;
  return (
    <>
      {reads === undefined ? null : <p>{reads}</p>}
      {can.terminal ? (
        <p>
          New session above the Fleet starts {agent.short} in a terminal tab
          {can.resume ? ', and Continue in All Sessions resumes an old one' : ''}.
        </p>
      ) : null}
      {can.launch ? (
        <p>
          The Launcher can run {agent.short} prompts
          {can.approvals ? ', with its permission requests in the inbox' : ''}.
        </p>
      ) : null}
    </>
  );
}

function AgentNotes(props: { readonly agent: AgentInfo }): ReactElement {
  const { agent } = props;
  return (
    <>
      <h3>
        {agent.name}{' '}
        <span className="muted">{agent.installed ? '(installed)' : '(not found on PATH)'}</span>
      </h3>
      {agent.id === CLAUDE_CODE ? (
        <ClaudeNotes can={agent.capabilities} />
      ) : (
        <OtherNotes agent={agent} />
      )}
    </>
  );
}

export function AgentsSection(): ReactElement {
  const agents = knownAgents(useAgents());
  return (
    <section className="section help-section" aria-labelledby="help-agents">
      <h2 id="help-agents">Agents</h2>
      <p className="muted">
        Overlord watches and runs several coding agent CLIs. Each agent gets the parts of Overlord
        it supports, and the views leave out the rest, so a dash in the Fleet means that agent does
        not report the number. Install an agent&apos;s CLI and sign in to it once in a terminal, and
        Overlord finds it on your PATH. The overlord.agents setting points Overlord at another
        binary or turns an agent off.
      </p>
      <FeatureTable agents={agents} />
      {agents.map((agent) => (
        <AgentNotes key={agent.id} agent={agent} />
      ))}
    </section>
  );
}
