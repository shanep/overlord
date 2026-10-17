// The crossSessionInbound selector: what this machine's sessions do with
// messages from the user's other sessions. Saving writes the user settings
// file after the host asks to confirm.

import type { ReactElement } from 'react';
import { useState } from 'react';

import { usePostAction } from '../vscode-context.js';

const UNSET = '';

/** Plain explanations, after the cross-session messaging docs. */
const INBOUND_HELP: Readonly<Record<string, string>> = {
  accept: 'Deliver each message to Claude.',
  hold: 'Show a notice for each message but do not deliver it. Held messages go through if accept applies later.',
  refuse:
    'Drop each message without delivering it. Other sessions see this one as unable to receive.',
};

const UNSET_HELP =
  'Claude Code decides per message from the permission modes: a session that prompts for permissions takes messages unless the sender bypasses prompts, and a session that bypasses prompts holds them for your approval.';

export function inboundHelp(value: string): string {
  return INBOUND_HELP[value] ?? 'A value Claude Code may not recognize.';
}

export function InboundPolicy(props: {
  readonly policy: string | null;
  readonly choices: readonly string[];
}): ReactElement {
  const { policy, choices } = props;
  const post = usePostAction();
  const current = policy ?? UNSET;
  const [picked, setPicked] = useState(current);
  const options = [...choices, UNSET];
  return (
    <section className="section" aria-labelledby="inbound-heading">
      <h2 id="inbound-heading" className="section-title">
        Messages from your other sessions
      </h2>
      <p className="muted">
        In effect now: <span className="mono">{policy ?? 'not set'}</span>. Saving writes{' '}
        <span className="mono">crossSessionInbound</span> to your user settings. A managed value,
        the --settings flag, or a stricter project value still wins.
      </p>
      <fieldset className="choice-grid">
        <legend className="visually-hidden">crossSessionInbound</legend>
        {options.map((value) => {
          const helpId = `inbound-help-${value === UNSET ? 'unset' : value}`;
          return (
            <div key={value} className="choice">
              <label>
                <input
                  type="radio"
                  name="inbound-policy"
                  value={value}
                  checked={picked === value}
                  aria-describedby={helpId}
                  onChange={() => {
                    setPicked(value);
                  }}
                />
                <span className="mono">{value === UNSET ? 'not set' : value}</span>
              </label>
              <p id={helpId}>{value === UNSET ? UNSET_HELP : inboundHelp(value)}</p>
            </div>
          );
        })}
      </fieldset>
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          disabled={picked === current}
          onClick={() => {
            post({ type: 'setInboundPolicy', value: picked === UNSET ? null : picked });
          }}
        >
          Save
        </button>
        {picked === current ? null : (
          <span className="muted">
            Changes to <span className="mono">{picked === UNSET ? 'not set' : picked}</span>
          </span>
        )}
      </div>
    </section>
  );
}
