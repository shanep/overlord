// The reputation, messages, help, activity, Tuning, Connectors, Skills and Agents views through the app's view switch. Kept
// apart from app.test.tsx, which another session owns.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CatalogKind, LibraryState } from '../../src/shared/catalog.js';
import { EMPTY_REGISTRY } from '../../src/shared/connectors.js';
import type { HostToWebview } from '../../src/shared/protocol.js';
import { NOW } from '../test/fixtures.js';
import { FakeApi } from '../test/render.js';

import { ViewSwitch } from './app.js';
import { NowProvider } from './clock.js';
import { VsCodeProvider } from './vscode-context.js';

function library(kind: CatalogKind): LibraryState {
  return {
    kind,
    installed: [],
    catalog: {
      sources: [],
      source: '',
      query: null,
      loading: false,
      entries: [],
      error: null,
      installing: null,
      notice: null,
    },
  };
}

const views: readonly HostToWebview[] = [
  {
    type: 'state',
    view: 'reputation',
    state: {
      prompts: 0,
      kind: 0,
      mean: 0,
      general: 0,
      score: 0,
      byDay: [],
      bySession: [],
      topKind: [],
      topMean: [],
      recent: [],
      scannedAt: null,
      leaderboard: {
        enabled: false,
        pageUrl: '',
        board: null,
        error: null,
        fetchedAt: null,
        mine: null,
      },
    },
  },
  {
    type: 'state',
    view: 'messages',
    state: { messages: [], routes: [], inboundPolicy: null, inboundChoices: [], rules: [] },
  },
  { type: 'state', view: 'help', state: {} },
  {
    type: 'state',
    view: 'activity',
    state: {
      sampledAt: null,
      intervalMs: 2000,
      machine: {
        cores: 1,
        cpuPct: null,
        loadAverage: [0, 0, 0],
        memoryTotalBytes: 1,
        memoryUsedBytes: null,
        swapUsedBytes: null,
        swapTotalBytes: null,
        memoryPressure: null,
        stall: null,
        cpuSpeedLimitPct: null,
        volumes: [],
      },
      sessions: [],
      alerts: [],
      notes: [],
    },
  },
  {
    type: 'state',
    view: 'tuning',
    state: {
      sessions: 0,
      totalUsd: 0,
      cacheReadUsd: 0,
      averageContext: 0,
      largestContext: 0,
      tips: [],
      suggestions: [],
      rows: [],
      scannedAt: null,
    },
  },
  {
    type: 'state',
    view: 'connectors',
    state: {
      connectors: [],
      checkedAt: null,
      checking: false,
      folder: null,
      registry: EMPTY_REGISTRY,
    },
  },
  { type: 'state', view: 'skills', state: library('skill') },
  { type: 'state', view: 'agents', state: library('agent') },
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
