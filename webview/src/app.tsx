// The root component. The host sets data-view on the root element, the app
// says ready for that view, and renders it once the first state arrives.

import type { ReactElement } from 'react';

import type { HostToWebview, ViewId } from '../../src/shared/protocol.js';
import { isViewId } from '../../src/shared/protocol.js';

import { EmptyState } from './components/empty-state.js';
import { ErrorBoundary } from './components/error-boundary.js';
import { useHostState } from './use-host-state.js';
import { AgentView } from './views/agent-view.js';
import { ConfigView } from './views/config-view.js';
import { ContextView } from './views/context-view.js';
import { FleetView } from './views/fleet-view.js';
import { FrustrationView } from './views/frustration-view.js';
import { KnobsView } from './views/knobs-view.js';
import { LauncherView } from './views/launcher-view.js';
import { MessagesView } from './views/messages-view.js';
import { SessionsView } from './views/sessions-view.js';
import { UsageView } from './views/usage-view.js';

/** The view named by the root element's data-view attribute, if valid. */
export function readViewId(element: HTMLElement): ViewId | null {
  const view = element.dataset['view'];
  return isViewId(view) ? view : null;
}

export function ViewSwitch(props: { readonly message: HostToWebview }): ReactElement {
  const { message } = props;
  switch (message.view) {
    case 'fleet': {
      return <FleetView state={message.state} />;
    }
    case 'agent': {
      return <AgentView state={message.state} />;
    }
    case 'context': {
      return <ContextView state={message.state} />;
    }
    case 'knobs': {
      return <KnobsView state={message.state} />;
    }
    case 'launcher': {
      return <LauncherView state={message.state} />;
    }
    case 'sessions': {
      return <SessionsView state={message.state} />;
    }
    case 'config': {
      return <ConfigView state={message.state} />;
    }
    case 'usage': {
      return <UsageView state={message.state} />;
    }
    case 'frustration': {
      return <FrustrationView state={message.state} />;
    }
    case 'messages': {
      return <MessagesView state={message.state} />;
    }
  }
}

export function App(props: { readonly view: ViewId }): ReactElement {
  const message = useHostState(props.view);
  return (
    <main className="app">
      <ErrorBoundary>
        {message === null ? (
          <EmptyState title="Waiting for data" detail="Overlord is loading this view." />
        ) : (
          <ViewSwitch message={message} />
        )}
      </ErrorBoundary>
    </main>
  );
}
