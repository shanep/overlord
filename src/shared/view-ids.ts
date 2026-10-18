// The ids of the webviews, shared by the protocol and the actions that open them.

export const VIEW_IDS = [
  'fleet',
  'agent',
  'context',
  'knobs',
  'launcher',
  'sessions',
  'config',
  'usage',
  'reputation',
  'messages',
  'properties',
  'help',
  'tuning',
  'connectors',
  'activity',
  'skills',
  'agents',
] as const;

export type ViewId = (typeof VIEW_IDS)[number];

const VIEW_ID_SET: ReadonlySet<string> = new Set(VIEW_IDS);

export function isViewId(value: unknown): value is ViewId {
  return typeof value === 'string' && VIEW_ID_SET.has(value);
}
