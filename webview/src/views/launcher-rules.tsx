// Auto-approve rules: tool and command or path patterns that allow or deny
// without asking. Deny rules always win. Each rule answers one agent or every
// agent, and a rule saved before rules had an agent answers Claude Code only.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { AgentId, AgentInfo } from '../../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../../src/shared/agents.js';
import type { AutoApproveRule } from '../../../src/shared/rules.js';
import { ALL_AGENTS } from '../../../src/shared/rules.js';
import { findAgent, knownAgents, useAgents } from '../agents.js';
import { Badge } from '../components/badge.js';
import { usePostAction } from '../vscode-context.js';

import { nullIfEmpty } from './knobs-values.js';

/** What the Agent column says for a rule's scope. */
function ruleScopeLabel(agents: readonly AgentInfo[], scope: AgentId | undefined): string {
  return scope === ALL_AGENTS ? 'All agents' : findAgent(agents, scope ?? CLAUDE_CODE).name;
}

function RuleRow(props: { readonly rule: AutoApproveRule }): ReactElement {
  const { rule } = props;
  const post = usePostAction();
  const agents = useAgents();
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          aria-label={`Enable rule for ${rule.tool}`}
          checked={rule.enabled}
          onChange={() => {
            post({ type: 'saveRule', rule: { ...rule, enabled: !rule.enabled } });
          }}
        />
      </td>
      <td>
        <Badge label={rule.behavior} tone={rule.behavior === 'allow' ? 'good' : 'critical'} />
      </td>
      <td>{ruleScopeLabel(agents, rule.agent)}</td>
      <td className="mono">{rule.tool}</td>
      <td className="mono">{rule.pattern ?? <span className="muted">any</span>}</td>
      <td className="wrap">{rule.description}</td>
      <td>
        <button
          type="button"
          aria-label={`Delete rule for ${rule.tool}`}
          onClick={() => {
            post({ type: 'deleteRule', ruleId: rule.id });
          }}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

function RuleForm(): ReactElement {
  const post = usePostAction();
  const agents = knownAgents(useAgents());
  const [agent, setAgent] = useState<AgentId>(CLAUDE_CODE);
  const [tool, setTool] = useState('');
  const [pattern, setPattern] = useState('');
  const [behavior, setBehavior] = useState<AutoApproveRule['behavior']>('allow');
  const [description, setDescription] = useState('');
  return (
    <div className="rule-form">
      <label>
        Agent
        <select
          value={agent}
          onChange={(event) => {
            setAgent(event.target.value);
          }}
        >
          {agents.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
          <option value={ALL_AGENTS}>All agents</option>
        </select>
      </label>
      <label>
        Tool
        <input
          type="text"
          value={tool}
          placeholder="Bash or mcp__github__*"
          onChange={(event) => {
            setTool(event.target.value);
          }}
        />
      </label>
      <label>
        Command or path
        <input
          type="text"
          value={pattern}
          placeholder="optional"
          onChange={(event) => {
            setPattern(event.target.value);
          }}
        />
      </label>
      <label>
        Action
        <select
          value={behavior}
          onChange={(event) => {
            setBehavior(event.target.value === 'deny' ? 'deny' : 'allow');
          }}
        >
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </select>
      </label>
      <label>
        Note
        <input
          type="text"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </label>
      <button
        type="button"
        className="primary"
        disabled={tool.trim() === ''}
        onClick={() => {
          post({
            type: 'saveRule',
            rule: {
              id: `rule-${Date.now().toString(36)}`,
              enabled: true,
              behavior,
              tool: tool.trim(),
              pattern: nullIfEmpty(pattern),
              description: description.trim(),
              agent,
            },
          });
          setTool('');
          setPattern('');
          setDescription('');
        }}
      >
        Add rule
      </button>
    </div>
  );
}

export function RulesEditor(props: { readonly rules: readonly AutoApproveRule[] }): ReactElement {
  return (
    <section className="section" aria-labelledby="rules-heading">
      <h2 id="rules-heading">Auto-approve rules</h2>
      <p className="hint">
        Rules answer permission requests for you, so runs do not stop to ask. Deny rules always win.
        A rule answers only the agent it names, and a Bash rule for another agent also covers its
        own shell. Every auto-approval is logged.
      </p>
      <div className="table-card">
        <table className="grid">
          <caption className="visually-hidden">Auto-approve rules</caption>
          <thead>
            <tr>
              <th scope="col">On</th>
              <th scope="col">Action</th>
              <th scope="col">Agent</th>
              <th scope="col">Tool</th>
              <th scope="col">Pattern</th>
              <th scope="col">Note</th>
              <th scope="col">Remove</th>
            </tr>
          </thead>
          <tbody>
            {props.rules.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No rules. Nothing is approved without asking.
                </td>
              </tr>
            ) : (
              props.rules.map((rule) => <RuleRow key={rule.id} rule={rule} />)
            )}
          </tbody>
        </table>
        <RuleForm />
      </div>
    </section>
  );
}
