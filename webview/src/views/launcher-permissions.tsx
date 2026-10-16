// Permission inbox: every pending approval from every agent in one list.

import type { ReactElement } from 'react';

import type { PermissionRequest } from '../../../src/shared/model.js';
import { useNow } from '../clock.js';
import { JsonView } from '../components/json-view.js';
import { formatAgo } from '../format.js';
import { usePostAction } from '../vscode-context.js';

const DENY_MESSAGE = 'Denied from Overlord';

export function PermissionInbox(props: {
  readonly requests: readonly PermissionRequest[];
}): ReactElement {
  const post = usePostAction();
  const now = useNow();
  return (
    <section className="section" aria-labelledby="inbox-heading">
      <h2 id="inbox-heading">Permission inbox ({props.requests.length})</h2>
      {props.requests.length === 0 ? <p className="muted">No pending requests.</p> : null}
      <ul className="feed">
        {props.requests.map((request) => (
          <li key={request.id}>
            <div className="toolbar">
              <code>{request.toolName}</code>
              <span className="muted">session {request.sessionId}</span>
              <span className="muted">{formatAgo(request.requestedAt, now)}</span>
              <span className="spacer" />
              <button
                type="button"
                className="primary"
                aria-label={`Allow ${request.toolName} for ${request.sessionId}`}
                onClick={() => {
                  post({
                    type: 'resolvePermission',
                    requestId: request.id,
                    decision: { behavior: 'allow', ruleId: null },
                  });
                }}
              >
                Allow
              </button>
              <button
                type="button"
                aria-label={`Deny ${request.toolName} for ${request.sessionId}`}
                onClick={() => {
                  post({
                    type: 'resolvePermission',
                    requestId: request.id,
                    decision: { behavior: 'deny', message: DENY_MESSAGE, ruleId: null },
                  });
                }}
              >
                Deny
              </button>
            </div>
            <details>
              <summary>Input</summary>
              <JsonView value={request.input} />
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
