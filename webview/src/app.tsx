// The root component. The host sets data-view on the root element, the app
// says ready for that view, and renders it once the first state arrives.

import type { ReactElement } from 'react';

import type { HostToWebview, ViewId } from '../../src/shared/protocol.js';
import { isViewId } from '../../src/shared/protocol.js';

import { EmptyState } from './components/empty-state.js';
import { ErrorBoundary } from './components/error-boundary.js';
import { TooltipLayer } from './components/tooltip.js';
import { useHostState } from './use-host-state.js';
import { AgentView } from './views/agent-view.js';
import { ConfigView } from './views/config-view.js';
import { ContextView } from './views/context-view.js';
import { FleetView } from './views/fleet-view.js';
import { HelpView } from './views/help-view.js';
import { KnobsView } from './views/knobs-view.js';
import { LauncherView } from './views/launcher-view.js';
import { MessagesView } from './views/messages-view.js';
import { PropertiesView } from './views/properties-view.js';
import { ReputationView } from './views/reputation-view.js';
import { SessionsView } from './views/sessions-view.js';
import { TuningView } from './views/tuning-view.js';
import { UsageView } from './views/usage-view.js';

/** The view named by the root element's data-view attribute, if valid. */
export function readViewId(element: HTMLElement): ViewId | null {
  const view = element.dataset['view'];
  return isViewId(view) ? view : null;
}

type GlobalView = 'knobs' | 'config' | 'usage' | 'reputation' | 'tuning' | 'help';
type GlobalMessage = Extract<HostToWebview, { readonly view: GlobalView }>;
type SessionMessage = Exclude<HostToWebview, GlobalMessage>;

const GLOBAL_VIEWS: ReadonlySet<ViewId> = new Set<GlobalView>([
  'knobs',
  'config',
  'usage',
  'reputation',
  'tuning',
  'help',
]);

function isGlobalMessage(message: HostToWebview): message is GlobalMessage {
  return GLOBAL_VIEWS.has(message.view);
}

/** The views listed under Global in the sidebar. */
function GlobalViewSwitch(props: { readonly message: GlobalMessage }): ReactElement {
  const { message } = props;
  switch (message.view) {
    case 'knobs': {
      return <KnobsView state={message.state} />;
    }
    case 'config': {
      return <ConfigView state={message.state} />;
    }
    case 'usage': {
      return <UsageView state={message.state} />;
    }
    case 'reputation': {
      return <ReputationView state={message.state} />;
    }
    case 'tuning': {
      return <TuningView state={message.state} />;
    }
    case 'help': {
      return <HelpView />;
    }
  }
}

/** The fleet and the views about particular sessions and agents. */
function SessionViewSwitch(props: { readonly message: SessionMessage }): ReactElement {
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
    case 'launcher': {
      return <LauncherView state={message.state} />;
    }
    case 'sessions': {
      return <SessionsView state={message.state} />;
    }
    case 'messages': {
      return <MessagesView state={message.state} />;
    }
    case 'properties': {
      return <PropertiesView state={message.state} />;
    }
  }
}

export function ViewSwitch(props: { readonly message: HostToWebview }): ReactElement {
  const { message } = props;
  return isGlobalMessage(message) ? (
    <GlobalViewSwitch message={message} />
  ) : (
    <SessionViewSwitch message={message} />
  );
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
      <TooltipLayer />
    </main>
  );
}
