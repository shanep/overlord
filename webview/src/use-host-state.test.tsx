import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import type { ViewId } from '../../src/shared/protocol.js';
import { usageState } from '../test/fixtures-tools.js';
import { fleetState } from '../test/fixtures.js';
import { FakeApi } from '../test/render.js';

import { isTrustedOrigin, useHostState } from './use-host-state.js';
import { VsCodeProvider } from './vscode-context.js';

function Probe(props: { readonly view: ViewId }): ReactElement {
  const message = useHostState(props.view);
  return (
    <output>
      {message === null
        ? 'none'
        : `${message.view}:${Object.keys(message.state).length.toString()}`}
    </output>
  );
}

function send(data: unknown, origin = 'vscode-webview://abc'): void {
  act(() => {
    globalThis.dispatchEvent(new MessageEvent('message', { data, origin }));
  });
}

describe('useHostState', () => {
  it('posts ready for its view on mount', () => {
    const api = new FakeApi();
    render(
      <VsCodeProvider api={api}>
        <Probe view="fleet" />
      </VsCodeProvider>,
    );
    expect(api.posted).toStrictEqual([{ type: 'ready', view: 'fleet' }]);
  });

  it('keeps the latest valid state for its view and ignores the rest', () => {
    const api = new FakeApi();
    const { getByRole } = render(
      <VsCodeProvider api={api}>
        <Probe view="fleet" />
      </VsCodeProvider>,
    );
    expect(getByRole('status').textContent).toBe('none');
    send({ type: 'state', view: 'usage', state: usageState });
    expect(getByRole('status').textContent).toBe('none');
    send({ type: 'state', view: 'fleet', state: { sessions: 'bad' } });
    expect(getByRole('status').textContent).toBe('none');
    send({ type: 'state', view: 'fleet', state: fleetState }, 'https://evil.example');
    expect(getByRole('status').textContent).toBe('none');
    send({ type: 'state', view: 'fleet', state: fleetState });
    expect(getByRole('status').textContent).toBe('fleet:8');
  });

  it('stops listening on unmount', () => {
    const api = new FakeApi();
    const { unmount } = render(
      <VsCodeProvider api={api}>
        <Probe view="fleet" />
      </VsCodeProvider>,
    );
    unmount();
    expect(() => {
      send({ type: 'state', view: 'fleet', state: fleetState });
    }).not.toThrow();
  });
});

describe('isTrustedOrigin', () => {
  it('trusts the webview origin and its own origin only', () => {
    expect(isTrustedOrigin('vscode-webview://123')).toBe(true);
    expect(isTrustedOrigin(globalThis.location.origin)).toBe(true);
    expect(isTrustedOrigin('https://example.com')).toBe(false);
  });
});
