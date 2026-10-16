// Auto-approve rules: tool and command or path patterns that allow or deny
// without asking. Deny rules always win.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { AutoApproveRule } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import { usePostAction } from '../vscode-context.js';

import { nullIfEmpty } from './knobs-values.js';

function RuleRow(props: { readonly rule: AutoApproveRule }): ReactElement {
  const { rule } = props;
  const post = usePostAction();
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
  const [tool, setTool] = useState('');
  const [pattern, setPattern] = useState('');
  const [behavior, setBehavior] = useState<AutoApproveRule['behavior']>('allow');
  const [description, setDescription] = useState('');
  return (
    <div className="toolbar">
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
      <p className="muted">Deny rules always win. Every auto-approval is logged.</p>
      <table className="grid">
        <caption className="visually-hidden">Auto-approve rules</caption>
        <thead>
          <tr>
            <th scope="col">On</th>
            <th scope="col">Action</th>
            <th scope="col">Tool</th>
            <th scope="col">Pattern</th>
            <th scope="col">Note</th>
            <th scope="col">Remove</th>
          </tr>
        </thead>
        <tbody>
          {props.rules.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No rules. Nothing is approved without asking.
              </td>
            </tr>
          ) : (
            props.rules.map((rule) => <RuleRow key={rule.id} rule={rule} />)
          )}
        </tbody>
      </table>
      <RuleForm />
    </section>
  );
}
