import { render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { FakeApi } from '../test/render.js';

import { isString } from './guards.js';
import { usePersistentState, usePostAction, useVsCode, VsCodeProvider } from './vscode-context.js';

function Counter(): ReactElement {
  const [value, setValue] = usePersistentState('note', 'start', isString);
  const post = usePostAction();
  return (
    <>
      <output>{value}</output>
      <button
        type="button"
        onClick={() => {
          setValue(`${value}!`);
        }}
      >
        Bump
      </button>
      <button
        type="button"
        onClick={() => {
          post({ type: 'stopAll' });
        }}
      >
        Stop
      </button>
    </>
  );
}

function ApiProbe(): ReactElement {
  const api = useVsCode();
  return <output>{typeof api.postMessage}</output>;
}

describe('usePersistentState', () => {
  it('starts from the initial value when nothing is saved', () => {
    const { getByRole } = render(
      <VsCodeProvider api={new FakeApi()}>
        <Counter />
      </VsCodeProvider>,
    );
    expect(getByRole('status').textContent).toBe('start');
  });

  it('restores a saved value and keeps other keys when saving', async () => {
    const api = new FakeApi({ note: 'saved', other: 1 });
    const { getByRole } = render(
      <VsCodeProvider api={api}>
        <Counter />
      </VsCodeProvider>,
    );
    expect(getByRole('status').textContent).toBe('saved');
    await userEvent.click(getByRole('button', { name: 'Bump' }));
    expect(getByRole('status').textContent).toBe('saved!');
    expect(api.saved).toStrictEqual({ note: 'saved!', other: 1 });
  });

  it('ignores saved values that fail the guard or a non object state', async () => {
    const api = new FakeApi({ note: 42 });
    const first = render(
      <VsCodeProvider api={api}>
        <Counter />
      </VsCodeProvider>,
    );
    expect(first.getByRole('status').textContent).toBe('start');
    first.unmount();
    const broken = new FakeApi('not an object');
    const { getByRole } = render(
      <VsCodeProvider api={broken}>
        <Counter />
      </VsCodeProvider>,
    );
    expect(getByRole('status').textContent).toBe('start');
    await userEvent.click(getByRole('button', { name: 'Bump' }));
    expect(broken.saved).toStrictEqual({ note: 'start!' });
  });
});

describe('usePostAction', () => {
  it('posts actions in the envelope', async () => {
    const api = new FakeApi();
    const { getByRole } = render(
      <VsCodeProvider api={api}>
        <Counter />
      </VsCodeProvider>,
    );
    await userEvent.click(getByRole('button', { name: 'Stop' }));
    expect(api.posted).toStrictEqual([{ type: 'action', action: { type: 'stopAll' } }]);
  });

  it('has a detached default without a provider', () => {
    const { getByRole } = render(<ApiProbe />);
    expect(getByRole('status').textContent).toBe('function');
  });
});
