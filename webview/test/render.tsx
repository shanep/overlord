// Test helpers: a fake VS Code API that records messages, a render wrapper
// with a pinned clock, and an axe check.

import type { RenderResult } from '@testing-library/react';
import { render } from '@testing-library/react';
import { run } from 'axe-core';
import type { ReactElement } from 'react';
import { expect } from 'vitest';

import type { WebviewAction, WebviewToHost } from '../../src/shared/protocol.js';
import { NowProvider } from '../src/clock.js';
import type { VsCodeApi } from '../src/vscode-api.js';
import { VsCodeProvider } from '../src/vscode-context.js';

import { NOW } from './fixtures.js';

export class FakeApi implements VsCodeApi {
  readonly posted: WebviewToHost[] = [];
  saved: unknown;

  constructor(saved?: unknown) {
    this.saved = saved;
  }

  postMessage = (message: WebviewToHost): void => {
    this.posted.push(message);
  };

  getState = (): unknown => this.saved;

  setState = (state: unknown): void => {
    this.saved = state;
  };

  actions(): WebviewAction[] {
    return this.posted.flatMap((message) => (message.type === 'action' ? [message.action] : []));
  }
}

export interface ViewRender extends RenderResult {
  readonly api: FakeApi;
}

export function renderView(ui: ReactElement, api: FakeApi = new FakeApi()): ViewRender {
  const result = render(
    <VsCodeProvider api={api}>
      <NowProvider now={NOW}>
        <main>{ui}</main>
      </NowProvider>
    </VsCodeProvider>,
  );
  return { ...result, api };
}

/** Fails the test with the rule ids and targets of any axe violation. */
export async function expectAccessible(container: Element): Promise<void> {
  const results = await run(container, {
    rules: {
      // jsdom has no layout or computed colors, so contrast cannot be measured.
      'color-contrast': { enabled: false },
    },
  });
  const found = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
  expect(found).toStrictEqual([]);
}

/** The first item, failing the test when there is none. */
export function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) {
    throw new Error('expected at least one item');
  }
  return item;
}

/** An unknown value that is undefined at run time, for testing that case. */
export function missingValue(): unknown {
  return new Map<string, unknown>().get('missing');
}
