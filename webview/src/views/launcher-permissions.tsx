// Permission inbox: every pending approval from every agent in one list.

import type { ReactElement } from 'react';

import {
  choiceDecision,
  type PermissionChoice,
  type PermissionRequest,
} from '../../../src/shared/model.js';
import { useNow } from '../clock.js';
import { Card, CardGrid, StatusDot } from '../components/card.js';
import { JsonView } from '../components/json-view.js';
import { formatAgo } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { alwaysAllowScope, offers } from './fleet-header.js';

const DENY_MESSAGE = 'Denied from Overlord';

export function PermissionInbox(props: {
  readonly requests: readonly PermissionRequest[];
}): ReactElement {
  const post = usePostAction();
  const now = useNow();
  const answer = (request: PermissionRequest, choice: PermissionChoice): void => {
    post({
      type: 'resolvePermission',
      requestId: request.id,
      decision: choiceDecision(choice, DENY_MESSAGE),
    });
  };
  return (
    <section className="section" aria-labelledby="inbox-heading">
      <h2 id="inbox-heading" className="section-title">
        Permission inbox <span className="count">{String(props.requests.length)}</span>
      </h2>
      {props.requests.length === 0 ? (
        <p className="muted">No pending requests.</p>
      ) : (
        <p className="hint">
          These runs want to use a tool and are waiting for your answer. Always allow adds a rule so
          the same thing does not ask again.
        </p>
      )}
      <CardGrid label="Pending permission requests" wide>
        {props.requests.map((request) => (
          <Card key={request.id} tone="warning">
            <div className="card-head">
              <StatusDot tone="warning" />
              <code className="card-title">{request.toolName}</code>
              <span className="muted">{formatAgo(request.requestedAt, now)}</span>
            </div>
            <div className="card-sub launch-indent">session {request.sessionId}</div>
            <details className="launch-indent">
              <summary>Input</summary>
              <JsonView value={request.input} />
            </details>
            <div className="card-foot">
              <span className="spacer" />
              <button
                type="button"
                title={alwaysAllowScope(request.toolName)}
                aria-label={`Always allow ${request.toolName} for ${request.sessionId}`}
                onClick={() => {
                  post({ type: 'alwaysAllowPermission', requestId: request.id });
                }}
              >
                Always allow
              </button>
              <button
                type="button"
                aria-label={`Deny ${request.toolName} for ${request.sessionId}`}
                onClick={() => {
                  answer(request, 'deny');
                }}
              >
                Deny
              </button>
              {offers(request, 'cancel') ? (
                <button
                  type="button"
                  title="Block this call and stop the current turn"
                  aria-label={`Deny ${request.toolName} and stop ${request.sessionId}`}
                  onClick={() => {
                    answer(request, 'cancel');
                  }}
                >
                  Stop turn
                </button>
              ) : null}
              {offers(request, 'allow_session') ? (
                <button
                  type="button"
                  title="Let this call run and let the agent skip asking again in this session"
                  aria-label={`Allow ${request.toolName} for the rest of ${request.sessionId}`}
                  onClick={() => {
                    answer(request, 'allow_session');
                  }}
                >
                  Allow for session
                </button>
              ) : null}
              <button
                type="button"
                className="primary"
                aria-label={`Allow ${request.toolName} for ${request.sessionId}`}
                onClick={() => {
                  answer(request, 'allow');
                }}
              >
                Allow
              </button>
            </div>
          </Card>
        ))}
      </CardGrid>
    </section>
  );
}
