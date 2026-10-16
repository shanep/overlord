// cspell:ignore unstub
import { render } from '@testing-library/react';
import type { EChartsOption } from 'echarts';
import { getInstanceByDom } from 'echarts/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EChart } from './chart.js';

const lineOption: EChartsOption = {
  xAxis: { type: 'category', data: ['a', 'b'] },
  yAxis: { type: 'value' },
  series: [{ type: 'line', data: [1, 2] }],
};

const barOption: EChartsOption = {
  xAxis: { type: 'category', data: ['a', 'b', 'c'] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', data: [3, 4, 5] }],
};

function chartElement(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.chart');
  if (element === null) {
    throw new Error('no chart element');
  }
  return element;
}

describe('EChart', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders an SVG chart with an accessible name and the given size', () => {
    const { getByRole, container } = render(
      <EChart option={lineOption} label="Tokens" height={120} width={300} />,
    );
    const element = getByRole('img', { name: 'Tokens' });
    expect(element.style.height).toBe('120px');
    expect(element.style.width).toBe('300px');
    expect(container.querySelector('svg')).not.toBeNull();
    const chart = getInstanceByDom(element);
    expect(chart?.getWidth()).toBe(300);
    expect(chart?.getHeight()).toBe(120);
  });

  it('fills the container width when no width is given', () => {
    const { container } = render(<EChart option={lineOption} label="Cost" height={100} />);
    const element = chartElement(container);
    expect(element.style.width).toBe('');
    expect(getInstanceByDom(element)?.getWidth()).toBe(640);
  });

  it('applies a new option without making a new instance', () => {
    const { container, rerender } = render(<EChart option={lineOption} label="A" height={100} />);
    const element = chartElement(container);
    const first = getInstanceByDom(element);
    rerender(<EChart option={barOption} label="A" height={100} />);
    const second = getInstanceByDom(element);
    expect(second).toBe(first);
    const series = second?.getOption()['series'];
    expect(JSON.stringify(series)).toContain('"type":"bar"');
  });

  it('disposes the instance on unmount', () => {
    const { container, unmount } = render(<EChart option={lineOption} label="A" height={100} />);
    const element = chartElement(container);
    const chart = getInstanceByDom(element);
    unmount();
    expect(chart?.isDisposed()).toBe(true);
  });

  it('resizes with its container and stops observing on unmount', () => {
    const observed: Element[] = [];
    const callbacks: (() => void)[] = [];
    let disconnected = 0;
    class FakeResizeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }

      observe(target: Element): void {
        observed.push(target);
      }

      disconnect(): void {
        disconnected += 1;
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { container, unmount } = render(<EChart option={lineOption} label="A" height={100} />);
    const element = chartElement(container);
    expect(observed).toStrictEqual([element]);
    const chart = getInstanceByDom(element);
    if (chart === undefined) {
      throw new Error('no chart instance');
    }
    const resize = vi.spyOn(chart, 'resize');
    for (const callback of callbacks) {
      callback();
    }
    expect(resize).toHaveBeenCalledTimes(1);
    unmount();
    expect(disconnected).toBe(1);
  });
});
