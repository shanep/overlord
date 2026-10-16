import { render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectAccessible, missingValue } from '../../test/render.js';

import { Badge, StateBadge, SurfaceBadge } from './badge.js';
import { ConfirmBar } from './confirm-bar.js';
import { EmptyState } from './empty-state.js';
import { ErrorBoundary } from './error-boundary.js';
import { formatJson, JsonView } from './json-view.js';
import { Meter, meterTone } from './meter.js';

describe('Badge', () => {
  it('renders a label with a tone class and title', () => {
    const { getByText } = render(<Badge label="modified" tone="warning" title="Changed" />);
    const badge = getByText('modified');
    expect(badge.className).toBe('badge badge-warning');
    expect(badge.title).toBe('Changed');
  });

  it('defaults to the neutral tone', () => {
    const { getByText } = render(<Badge label="x" />);
    expect(getByText('x').className).toBe('badge badge-neutral');
  });

  it('shows state as a hidden glyph plus a word', () => {
    const { container } = render(<StateBadge state="failed" />);
    const state = container.querySelector('.state');
    expect(state?.className).toBe('state state-critical');
    expect(state?.textContent).toBe('✕failed');
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('✕');
    expect(state?.getAttribute('title')).toBe('failed: Ended with an error.');
  });

  it('names the surface', () => {
    const { getByText } = render(<SurfaceBadge surface="desktop-code" />);
    expect(getByText('Desktop').className).toBe('badge badge-info');
  });
});

describe('Meter', () => {
  it('picks a tone by severity', () => {
    expect(meterTone(0.2)).toBe('info');
    expect(meterTone(0.7)).toBe('warning');
    expect(meterTone(0.95)).toBe('critical');
  });

  it('exposes the percent to assistive tech and as text', async () => {
    const { getByRole, getByText, container } = render(
      <main>
        <Meter label="Context" ratio={0.823} />
      </main>,
    );
    const meter = getByRole('meter', { name: 'Context' });
    expect(meter.getAttribute('aria-valuenow')).toBe('82');
    expect(getByText('82%')).toBeDefined();
    const fill = container.querySelector<HTMLElement>('.meter-fill');
    expect(fill?.style.width).toBe('82%');
    expect(fill?.className).toBe('meter-fill meter-warning');
    await expectAccessible(container);
  });

  it('clamps out of range ratios and shows n/a for null', () => {
    const { getByRole, rerender, getByText } = render(<Meter label="Limit" ratio={1.4} />);
    expect(getByRole('meter').getAttribute('aria-valuenow')).toBe('100');
    rerender(<Meter label="Limit" ratio={-1} />);
    expect(getByRole('meter').getAttribute('aria-valuenow')).toBe('0');
    rerender(<Meter label="Limit" ratio={null} />);
    expect(getByText('n/a')).toBeDefined();
  });
});

describe('EmptyState', () => {
  it('shows a title and optional detail', () => {
    const { getByRole, rerender } = render(<EmptyState title="Nothing" detail="Try later." />);
    expect(getByRole('status').textContent).toBe('NothingTry later.');
    rerender(<EmptyState title="Nothing" />);
    expect(getByRole('status').textContent).toBe('Nothing');
  });
});

function Thrower(props: { readonly value: unknown }): ReactElement {
  if (props.value instanceof Error || typeof props.value === 'string') {
    // Throwing a non Error is what the boundary's String() branch is for.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw props.value;
  }
  return <p>fine</p>;
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Thrower value={null} />
      </ErrorBoundary>,
    );
    expect(getByText('fine')).toBeDefined();
  });

  it('shows the error message instead of a blank panel', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      // React logs caught errors; keep test output clean.
    });
    const { getByRole, rerender } = render(
      <ErrorBoundary>
        <Thrower value={new Error('boom')} />
      </ErrorBoundary>,
    );
    expect(getByRole('alert').textContent).toBe('This view hit an error.boom');
    rerender(
      <ErrorBoundary key="second">
        <Thrower value="plain" />
      </ErrorBoundary>,
    );
    expect(getByRole('alert').textContent).toContain('plain');
  });
});

describe('JsonView', () => {
  it('pretty prints values', () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatJson(missingValue())).toBe('undefined');
    const { container } = render(<JsonView value={[1, 2]} />);
    expect(container.querySelector('pre')?.textContent).toBe('[\n  1,\n  2\n]');
  });
});

describe('ConfirmBar', () => {
  it('focuses confirm and calls back on click', async () => {
    const onConfirm = vi.fn<() => void>();
    const onCancel = vi.fn<() => void>();
    const { getByRole, container } = render(
      <main>
        <ConfirmBar
          message="Stop it?"
          confirmLabel="Stop"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </main>,
    );
    expect(document.activeElement).toBe(getByRole('button', { name: 'Stop' }));
    expect(getByRole('group', { name: 'Confirm' }).textContent).toContain('Stop it?');
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await expectAccessible(container);
  });

  it('cancels on Escape from either button and ignores other keys', async () => {
    const onCancel = vi.fn<() => void>();
    const { getByRole } = render(
      <ConfirmBar
        message="Go?"
        confirmLabel="Go"
        onConfirm={vi.fn<() => void>()}
        onCancel={onCancel}
      />,
    );
    await userEvent.keyboard('a');
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    getByRole('button', { name: 'Cancel' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
