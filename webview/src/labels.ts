// Display names for enum values from the shared model.

import type { SessionState, Surface } from '../../src/shared/model.js';

export type Tone = 'neutral' | 'info' | 'good' | 'warning' | 'critical';

export const SURFACE_LABELS: Readonly<Record<Surface, string>> = {
  cli: 'CLI',
  sdk: 'SDK',
  overlord: 'Overlord',
  'desktop-code': 'Desktop',
  cowork: 'Cowork',
  cloud: 'Cloud',
  'claude-ai': 'claude.ai',
};

export const SURFACES: readonly Surface[] = [
  'cli',
  'sdk',
  'overlord',
  'desktop-code',
  'cowork',
  'cloud',
  'claude-ai',
];

export interface StateInfo {
  readonly label: string;
  /** A glyph so state never depends on color alone. */
  readonly icon: string;
  readonly tone: Tone;
}

export const STATE_INFO: Readonly<Record<SessionState, StateInfo>> = {
  running: { label: 'running', icon: '▶', tone: 'good' },
  waiting: { label: 'waiting', icon: '!', tone: 'warning' },
  idle: { label: 'idle', icon: '○', tone: 'neutral' },
  done: { label: 'done', icon: '✓', tone: 'neutral' },
  failed: { label: 'failed', icon: '✕', tone: 'critical' },
  unknown: { label: 'unknown', icon: '?', tone: 'neutral' },
};

/** Sort rank so active work sorts first: waiting, running, idle, then the rest. */
export const STATE_RANK: Readonly<Record<SessionState, number>> = {
  waiting: 0,
  running: 1,
  idle: 2,
  unknown: 3,
  failed: 4,
  done: 5,
};

const SURFACE_SET: ReadonlySet<string> = new Set(SURFACES);

export function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && SURFACE_SET.has(value);
}
