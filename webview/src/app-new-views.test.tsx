// The frustration, messages and help views through the app's view switch. Kept
// apart from app.test.tsx, which another session owns.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { HostToWebview } from '../../src/shared/protocol.js';
import { NOW } from '../test/fixtures.js';
import { FakeApi } from '../test/render.js';

import { ViewSwitch } from './app.js';
import { NowProvider } from './clock.js';
import { VsCodeProvider } from './vscode-context.js';

const views: readonly HostToWebview[] = [
  {
    type: 'state',
    view: 'frustration',
    state: {
      totalPrompts: 0,
      atClaude: 0,
      general: 0,
      byDay: [],
      bySession: [],
      topTerms: [],
      recent: [],
      scannedAt: null,
    },
  },
  {
    type: 'state',
    view: 'messages',
    state: { messages: [], routes: [], inboundPolicy: null, inboundChoices: [], rules: [] },
  },
  { type: 'state', view: 'help', state: {} },
];

describe('ViewSwitch for the newer views', () => {
  it.each(views.map((message): [string, HostToWebview] => [message.view, message]))(
    'renders the %s view',
    (_view, message) => {
      const { container } = render(
        <VsCodeProvider api={new FakeApi()}>
          <NowProvider now={NOW}>
            <main>
              <ViewSwitch message={message} />
            </main>
          </NowProvider>
        </VsCodeProvider>,
      );
      expect(container.querySelector('section, [role="status"]')).not.toBeNull();
    },
  );
});
