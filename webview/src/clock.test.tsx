import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NowProvider, useNow } from './clock.js';

function Clock(): ReactElement {
  return <output>{useNow().toString()}</output>;
}

describe('useNow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the pinned time from NowProvider', () => {
    const { getByRole } = render(
      <NowProvider now={1234}>
        <Clock />
      </NowProvider>,
    );
    expect(getByRole('status').textContent).toBe('1234');
  });

  it('ticks once a second without a provider and stops on unmount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { getByRole, unmount } = render(<Clock />);
    expect(getByRole('status').textContent).toBe('10000');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(getByRole('status').textContent).toBe('11000');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
