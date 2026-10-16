// Display names for enum values from the shared model.

import type { SessionPlace, SessionState, Surface } from '../../src/shared/model.js';

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

export interface PlaceInfo {
  readonly label: string;
  readonly icon: 'window' | 'prompt' | 'layers';
  readonly tone: Tone;
  /** Shown when you hover the badge. */
  readonly description: string;
}

export const PLACE_INFO: Readonly<Record<SessionPlace, PlaceInfo>> = {
  vscode: {
    label: 'VS Code',
    icon: 'window',
    tone: 'good',
    description: 'Open in a terminal in this VS Code window',
  },
  terminal: {
    label: 'Terminal',
    icon: 'prompt',
    tone: 'neutral',
    description: 'Open in a terminal outside this VS Code window',
  },
  background: {
    label: 'Background',
    icon: 'layers',
    tone: 'neutral',
    description: 'Running in the background with no terminal',
  },
};

export interface StateInfo {
  readonly label: string;
  /** A glyph so state never depends on color alone. */
  readonly icon: string;
  readonly tone: Tone;
  /** What the state means, shown when you hover the badge. */
  readonly description: string;
}

export const STATE_INFO: Readonly<Record<SessionState, StateInfo>> = {
  running: {
    label: 'running',
    icon: '▶',
    tone: 'good',
    description: 'Working on a turn or running a tool right now.',
  },
  waiting: {
    label: 'waiting',
    icon: '!',
    tone: 'warning',
    description: 'Blocked on a permission prompt that needs your answer.',
  },
  idle: {
    label: 'idle',
    icon: '○',
    tone: 'neutral',
    description: 'Not working: the last turn finished and it is waiting for your next prompt.',
  },
  done: {
    label: 'done',
    icon: '✓',
    tone: 'neutral',
    description: 'Finished its work.',
  },
  failed: {
    label: 'failed',
    icon: '✕',
    tone: 'critical',
    description: 'Ended with an error.',
  },
  unknown: {
    label: 'unknown',
    icon: '?',
    tone: 'neutral',
    description: 'No activity read from its transcript yet, so the state cannot be told.',
  },
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

/** Surfaces whose sessions have a local transcript Claude Code can continue or show. */
export const LOCAL_SURFACES: ReadonlySet<Surface> = new Set<Surface>([
  'cli',
  'sdk',
  'overlord',
  'desktop-code',
]);
