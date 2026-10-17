// Block rules for SendMessage. SendMessage never asks permission, so Overlord
// applies these on the PreToolUse hook, and only deny rules act there. The
// pattern matches the recipient (the `to` input).

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { AutoApproveRule } from '../../../src/shared/rules.js';
import { Badge } from '../components/badge.js';
import { usePostAction } from '../vscode-context.js';

const SEND_MESSAGE = 'SendMessage';

export function newBlockRule(pattern: string, description: string, id: string): AutoApproveRule {
  return {
    id,
    enabled: true,
    behavior: 'deny',
    tool: SEND_MESSAGE,
    pattern: pattern.trim(),
    description: description.trim(),
  };
}

function RuleRow(props: { readonly rule: AutoApproveRule }): ReactElement {
  const { rule } = props;
  const post = usePostAction();
  const target = rule.pattern ?? 'every recipient';
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          aria-label={`Enable rule for ${target}`}
          checked={rule.enabled}
          onChange={() => {
            post({ type: 'saveRule', rule: { ...rule, enabled: !rule.enabled } });
          }}
        />
      </td>
      <td>
        {rule.behavior === 'deny' ? (
          <Badge label="block" tone="critical" />
        ) : (
          <Badge
            label="allow (no effect)"
            title="SendMessage never asks, so allow rules do nothing"
          />
        )}
      </td>
      <td className="mono">{rule.tool}</td>
      <td className="mono">{rule.pattern ?? <span className="muted">any</span>}</td>
      <td className="wrap">{rule.description}</td>
      <td>
        <button
          type="button"
          aria-label={`Delete rule for ${target}`}
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

function BlockForm(): ReactElement {
  const post = usePostAction();
  const [pattern, setPattern] = useState('');
  const [description, setDescription] = useState('');
  return (
    <div className="toolbar">
      <label>
        Recipient pattern
        <input
          type="text"
          value={pattern}
          placeholder="uds:* or wt-apps-*"
          onChange={(event) => {
            setPattern(event.target.value);
          }}
        />
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
        disabled={pattern.trim() === ''}
        onClick={() => {
          post({
            type: 'saveRule',
            rule: newBlockRule(pattern, description, `rule-${Date.now().toString(36)}`),
          });
          setPattern('');
          setDescription('');
        }}
      >
        Add block rule
      </button>
    </div>
  );
}

export function BlockRules(props: { readonly rules: readonly AutoApproveRule[] }): ReactElement {
  return (
    <section className="section" aria-labelledby="block-rules-heading">
      <h2 id="block-rules-heading" className="section-title">
        Block rules for SendMessage
      </h2>
      <p className="muted">
        SendMessage never asks permission, so Overlord blocks it from the PreToolUse hook. The
        pattern matches the recipient: an agent name or id, main, a session name, or a uds: address.
        Use * to block every send. Hooks must be installed.
      </p>
      <table className="grid">
        <caption className="visually-hidden">Rules that cover SendMessage</caption>
        <thead>
          <tr>
            <th scope="col">On</th>
            <th scope="col">Action</th>
            <th scope="col">Tool</th>
            <th scope="col">Recipient</th>
            <th scope="col">Note</th>
            <th scope="col">Remove</th>
          </tr>
        </thead>
        <tbody>
          {props.rules.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No rules. Every send goes through.
              </td>
            </tr>
          ) : (
            props.rules.map((rule) => <RuleRow key={rule.id} rule={rule} />)
          )}
        </tbody>
      </table>
      <BlockForm />
    </section>
  );
}
