import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { HostToWebview, ViewId } from '../../src/shared/protocol.js';
import { contextState, knobsState } from '../test/fixtures-context.js';
import { configState, launcherState, sessionsState, usageState } from '../test/fixtures-tools.js';
import { agentState, fleetState, NOW, session } from '../test/fixtures.js';
import { expectAccessible, FakeApi } from '../test/render.js';

import { App, readViewId, ViewSwitch } from './app.js';
import { NowProvider } from './clock.js';
import { VsCodeProvider } from './vscode-context.js';

const messages: readonly HostToWebview[] = [
  { type: 'state', view: 'fleet', state: fleetState },
  { type: 'state', view: 'agent', state: agentState },
  { type: 'state', view: 'context', state: contextState },
  { type: 'state', view: 'knobs', state: knobsState },
  { type: 'state', view: 'launcher', state: launcherState },
  { type: 'state', view: 'sessions', state: sessionsState },
  { type: 'state', view: 'config', state: configState },
  { type: 'state', view: 'usage', state: usageState },
  {
    type: 'state',
    view: 'properties',
    state: { sessionId: 's1', session: session({ id: 's1' }), agents: [], pendingPermissions: [] },
  },
];

describe('readViewId', () => {
  it('reads a valid data-view attribute', () => {
    const root = document.createElement('div');
    root.dataset['view'] = 'knobs';
    expect(readViewId(root)).toBe('knobs');
  });

  it('returns null for a missing or unknown view', () => {
    const root = document.createElement('div');
    expect(readViewId(root)).toBeNull();
    root.dataset['view'] = 'htop';
    expect(readViewId(root)).toBeNull();
  });
});

describe('ViewSwitch', () => {
  it.each(messages.map((message): [ViewId, HostToWebview] => [message.view, message]))(
    'renders the %s view without errors and passes axe',
    async (_view, message) => {
      const { container, queryByRole } = render(
        <VsCodeProvider api={new FakeApi()}>
          <NowProvider now={NOW}>
            <main>
              <ViewSwitch message={message} />
            </main>
          </NowProvider>
        </VsCodeProvider>,
      );
      expect(container.querySelector('section, [role="status"]')).not.toBeNull();
      expect(queryByRole('alert')).toBeNull();
      await expectAccessible(container);
    },
  );
});

describe('App', () => {
  it('says ready, waits, then renders the view the host sends', async () => {
    const api = new FakeApi();
    const { getByRole, queryByText, container } = render(
      <VsCodeProvider api={api}>
        <NowProvider now={NOW}>
          <App view="usage" />
        </NowProvider>
      </VsCodeProvider>,
    );
    expect(api.posted).toStrictEqual([{ type: 'ready', view: 'usage' }]);
    expect(getByRole('status').textContent).toContain('Waiting for data');
    act(() => {
      globalThis.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'state', view: 'usage', state: usageState },
          origin: 'vscode-webview://panel',
        }),
      );
    });
    expect(queryByText('Waiting for data')).toBeNull();
    expect(getByRole('heading', { name: 'Usage' })).toBeDefined();
    expect(getByRole('main')).toBeDefined();
    await expectAccessible(container);
  });
});
