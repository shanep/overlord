import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { placeTip, TIP_DELAY_MS, TooltipLayer } from './tooltip.js';

const VIEW = { width: 400, height: 300 };
const SIZE = { width: 100, height: 20 };

describe('placeTip', () => {
  it('centers the tip under its element', () => {
    const anchor = { left: 150, top: 50, bottom: 70, width: 20 };
    expect(placeTip(anchor, SIZE, VIEW)).toStrictEqual({ left: 110, top: 74 });
  });

  it('puts the tip above when there is no room below', () => {
    const anchor = { left: 150, top: 270, bottom: 290, width: 20 };
    expect(placeTip(anchor, SIZE, VIEW)).toStrictEqual({ left: 110, top: 246 });
  });

  it('keeps the tip inside the view at either edge', () => {
    expect(placeTip({ left: 0, top: 50, bottom: 70, width: 20 }, SIZE, VIEW).left).toBe(4);
    expect(placeTip({ left: 390, top: 50, bottom: 70, width: 10 }, SIZE, VIEW).left).toBe(296);
  });
});

function tooltip(): HTMLElement | null {
  return screen.queryByRole('tooltip');
}

function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

// Built by hand, since React would trip over a node removed under it.
function liveTip(text: string): HTMLButtonElement {
  const live = document.createElement('button');
  live.dataset['tip'] = text;
  document.body.append(live);
  fireEvent.pointerOver(live);
  wait(TIP_DELAY_MS);
  return live;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('TooltipLayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderLayer(): void {
    render(
      <div>
        <button type="button" data-tip="Stop: End the session">
          <span>stop</span>
        </button>
        <button type="button" data-tip="Interrupt: Stop the current turn" disabled>
          interrupt
        </button>
        <button type="button" data-tip="">
          blank
        </button>
        <span>plain</span>
        <TooltipLayer />
      </div>,
    );
  }

  it('shows the tip after a short rest and hides it when the pointer leaves', () => {
    renderLayer();
    fireEvent.pointerOver(screen.getByText('stop'));
    wait(TIP_DELAY_MS - 1);
    expect(tooltip()).toBeNull();
    wait(1);
    expect(tooltip()?.textContent).toBe('Stop: End the session');
    expect(tooltip()?.style.top).toMatch(/px$/u);
    fireEvent.pointerOver(screen.getByText('plain'));
    expect(tooltip()).toBeNull();
  });

  it('shows the next tip at once while one is up, even on a disabled button', () => {
    renderLayer();
    fireEvent.pointerOver(screen.getByText('stop'));
    wait(TIP_DELAY_MS);
    fireEvent.pointerOver(screen.getByText('interrupt'));
    expect(tooltip()?.textContent).toBe('Interrupt: Stop the current turn');
  });

  it('waits again after the pointer leaves for something without a tip', () => {
    renderLayer();
    fireEvent.pointerOver(screen.getByText('stop'));
    wait(TIP_DELAY_MS);
    fireEvent.pointerOver(screen.getByText('plain'));
    fireEvent.pointerOver(screen.getByText('interrupt'));
    expect(tooltip()).toBeNull();
    wait(TIP_DELAY_MS);
    expect(tooltip()).not.toBeNull();
  });

  it('cancels a tip that has not shown yet', () => {
    renderLayer();
    fireEvent.pointerOver(screen.getByText('stop'));
    fireEvent.pointerOver(screen.getByText('plain'));
    wait(TIP_DELAY_MS);
    expect(tooltip()).toBeNull();
  });

  it('shows nothing for an empty tip', () => {
    renderLayer();
    fireEvent.pointerOver(screen.getByText('blank'));
    wait(TIP_DELAY_MS);
    expect(tooltip()).toBeNull();
  });

  it('hides on a click and stays hidden until the pointer moves on', () => {
    renderLayer();
    const stop = screen.getByText('stop');
    fireEvent.pointerOver(stop);
    wait(TIP_DELAY_MS);
    fireEvent.pointerDown(stop);
    expect(tooltip()).toBeNull();
    fireEvent.pointerOver(stop);
    wait(TIP_DELAY_MS);
    expect(tooltip()).toBeNull();
  });

  it('hides when the pointer leaves the page', () => {
    renderLayer();
    fireEvent.pointerOver(screen.getByText('stop'));
    wait(TIP_DELAY_MS);
    fireEvent.pointerOut(screen.getByText('stop'), { relatedTarget: screen.getByText('plain') });
    expect(tooltip()).not.toBeNull();
    fireEvent.pointerOut(screen.getByText('stop'), { relatedTarget: null });
    expect(tooltip()).toBeNull();
  });

  it('ignores pointer events that are not on an element', () => {
    renderLayer();
    fireEvent.pointerOver(document);
    wait(TIP_DELAY_MS);
    expect(tooltip()).toBeNull();
  });

  it('follows a tip that changes and hides when the tip is taken off', async () => {
    render(<TooltipLayer />);
    const live = liveTip('Cost: So far');
    live.dataset['tip'] = 'Cost: Now with new words';
    await flush();
    expect(tooltip()?.textContent).toBe('Cost: Now with new words');
    delete live.dataset['tip'];
    await flush();
    expect(tooltip()).toBeNull();
    live.remove();
  });

  it('hides when its element goes away', async () => {
    render(<TooltipLayer />);
    const live = liveTip('Cost: So far');
    expect(tooltip()).not.toBeNull();
    live.remove();
    await flush();
    expect(tooltip()).toBeNull();
  });
});
