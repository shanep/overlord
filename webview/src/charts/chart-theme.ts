// Chart colors come from the VS Code theme so charts match light, dark and
// high contrast themes. Each value falls back to a validated default when
// the variable is missing (outside VS Code, or in tests).

import { useEffect, useState } from 'react';

export interface ChartTheme {
  readonly dark: boolean;
  readonly foreground: string;
  readonly muted: string;
  readonly grid: string;
  readonly surface: string;
  readonly fontFamily: string;
  /** Categorical slots in fixed order. Assign in sequence, never cycle. */
  readonly series: readonly string[];
  readonly good: string;
  readonly warning: string;
  readonly critical: string;
  /** Sequential ramp, low to high, already flipped for dark themes. */
  readonly sequential: readonly string[];
}

// Slot order chosen with the palette validator over VS Code's default chart
// colors and the fallbacks, light and dark. The first four slots separate
// well under color vision deficiency; charts fold anything past four series
// into "Other" and always ship a legend and a table view.
interface Slot {
  readonly name: string;
  readonly light: string;
  readonly dark: string;
}

const BLUE: Slot = { name: 'blue', light: '#2a78d6', dark: '#3987e5' };
const ORANGE: Slot = { name: 'orange', light: '#eb6834', dark: '#d95926' };
const PURPLE: Slot = { name: 'purple', light: '#6250d6', dark: '#9085e9' };
const YELLOW: Slot = { name: 'yellow', light: '#eda100', dark: '#c98500' };
const RED: Slot = { name: 'red', light: '#e34948', dark: '#e66767' };
const GREEN: Slot = { name: 'green', light: '#008300', dark: '#008300' };
const SLOTS: readonly Slot[] = [BLUE, ORANGE, PURPLE, YELLOW, GREEN, RED];
const RAMP_LIGHT = ['#cde2fb', '#9ec5f4', '#5598e7', '#256abf', '#104281'];
const RAMP_DARK = ['#104281', '#256abf', '#3987e5', '#6da7ec', '#b7d3f6'];

/** True for the VS Code dark and high contrast dark themes. */
export function isDarkTheme(body: HTMLElement): boolean {
  const kind = body.dataset['vscodeThemeKind'];
  if (kind !== undefined) {
    return kind === 'vscode-dark' || kind === 'vscode-high-contrast';
  }
  return body.classList.contains('vscode-dark') || body.classList.contains('vscode-high-contrast');
}

function cssVariable(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/** Read the current theme from the computed style of `element`. */
export function readChartTheme(element: HTMLElement): ChartTheme {
  const style = getComputedStyle(element);
  const dark = isDarkTheme(element);
  const read = (name: string, fallback: string): string => cssVariable(style, name, fallback);
  const slot = (entry: Slot): string =>
    read(`--vscode-charts-${entry.name}`, dark ? entry.dark : entry.light);
  return {
    dark,
    foreground: read('--vscode-foreground', dark ? '#cccccc' : '#3b3b3b'),
    muted: read('--vscode-descriptionForeground', dark ? '#9d9d9d' : '#717171'),
    grid: read('--vscode-editorWidget-border', dark ? '#454545' : '#c8c8c8'),
    surface: read('--vscode-editor-background', dark ? '#1e1e1e' : '#ffffff'),
    fontFamily: read('--vscode-font-family', 'system-ui, sans-serif'),
    series: SLOTS.map((entry) => slot(entry)),
    good: slot(GREEN),
    warning: slot(YELLOW),
    critical: slot(RED),
    sequential: dark ? RAMP_DARK : RAMP_LIGHT,
  };
}

/** Series color for slot `index`. Past the palette it is the muted ink, for "Other". */
export function seriesColor(theme: ChartTheme, index: number): string {
  return theme.series[index] ?? theme.muted;
}

/** The theme for document.body, updated when VS Code switches themes. */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(() => readChartTheme(document.body));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(readChartTheme(document.body));
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-vscode-theme-kind'],
    });
    return (): void => {
      observer.disconnect();
    };
  }, []);
  return theme;
}
