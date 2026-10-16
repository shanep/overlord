import { act, render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { isDarkTheme, readChartTheme, seriesColor, useChartTheme } from './chart-theme.js';

function element(classes: string[], kind?: string): HTMLElement {
  const node = document.createElement('div');
  node.classList.add(...classes);
  if (kind !== undefined) {
    node.dataset['vscodeThemeKind'] = kind;
  }
  return node;
}

function ThemeProbe(): ReactElement {
  const theme = useChartTheme();
  return <output>{`${String(theme.dark)} ${theme.series[0] ?? ''}`}</output>;
}

describe('isDarkTheme', () => {
  it('prefers the theme kind attribute', () => {
    expect(isDarkTheme(element([], 'vscode-dark'))).toBe(true);
    expect(isDarkTheme(element([], 'vscode-high-contrast'))).toBe(true);
    expect(isDarkTheme(element(['vscode-dark'], 'vscode-light'))).toBe(false);
    expect(isDarkTheme(element([], 'vscode-high-contrast-light'))).toBe(false);
  });

  it('falls back to body classes', () => {
    expect(isDarkTheme(element(['vscode-dark']))).toBe(true);
    expect(isDarkTheme(element(['vscode-high-contrast']))).toBe(true);
    expect(isDarkTheme(element(['vscode-light']))).toBe(false);
  });
});

describe('readChartTheme', () => {
  it('uses validated light fallbacks with no theme variables', () => {
    const theme = readChartTheme(element([]));
    expect(theme.dark).toBe(false);
    expect(theme.series).toStrictEqual([
      '#2a78d6',
      '#eb6834',
      '#6250d6',
      '#eda100',
      '#008300',
      '#e34948',
    ]);
    expect(theme.good).toBe('#008300');
    expect(theme.warning).toBe('#eda100');
    expect(theme.critical).toBe('#e34948');
    expect(theme.surface).toBe('#ffffff');
    expect(theme.sequential[0]).toBe('#cde2fb');
  });

  it('uses dark fallbacks and flips the sequential ramp', () => {
    const theme = readChartTheme(element(['vscode-dark']));
    expect(theme.series[0]).toBe('#3987e5');
    expect(theme.surface).toBe('#1e1e1e');
    expect(theme.foreground).toBe('#cccccc');
    expect(theme.sequential[0]).toBe('#104281');
  });

  it('reads VS Code theme variables when present', () => {
    const node = element(['vscode-dark']);
    node.style.setProperty('--vscode-charts-blue', '#3794ff');
    node.style.setProperty('--vscode-charts-red', ' #f14c4c ');
    node.style.setProperty('--vscode-foreground', '#eeeeee');
    node.style.setProperty('--vscode-font-family', 'Menlo');
    document.body.append(node);
    const theme = readChartTheme(node);
    node.remove();
    expect(theme.series[0]).toBe('#3794ff');
    expect(theme.critical).toBe('#f14c4c');
    expect(theme.series[5]).toBe('#f14c4c');
    expect(theme.foreground).toBe('#eeeeee');
    expect(theme.fontFamily).toBe('Menlo');
  });
});

describe('seriesColor', () => {
  it('returns slots in order and the muted ink past the palette', () => {
    const theme = readChartTheme(element([]));
    expect(seriesColor(theme, 1)).toBe('#eb6834');
    expect(seriesColor(theme, 6)).toBe(theme.muted);
  });
});

describe('useChartTheme', () => {
  afterEach(() => {
    document.body.className = '';
  });

  it('updates when VS Code switches the body theme class', async () => {
    document.body.className = 'vscode-light';
    const { getByRole, unmount } = render(<ThemeProbe />);
    expect(getByRole('status').textContent).toBe('false #2a78d6');
    act(() => {
      document.body.className = 'vscode-dark';
    });
    await waitFor(() => {
      expect(getByRole('status').textContent).toBe('true #3987e5');
    });
    unmount();
  });
});
