// Maps ACP permission options to the inbox's choices and back.

import type { PermissionOption, RequestPermissionOutcome } from '@agentclientprotocol/sdk';

import type { PermissionChoice } from '../../../shared/model.js';
import type { ToolPermissionResult } from '../shared/runtime.js';

type OptionKind = PermissionOption['kind'];

/** The answers the inbox may give for these ACP options. */
export function permissionChoices(options: readonly PermissionOption[]): PermissionChoice[] {
  const kinds = new Set(options.map((option) => option.kind));
  const allow = kinds.has('allow_once') || kinds.has('allow_always');
  return [
    ...(allow ? (['allow'] as const) : []),
    ...(kinds.has('allow_always') ? (['allow_session'] as const) : []),
    'deny',
    'cancel',
  ];
}

/** The option kinds that fit a decision, best first. */
function kindsFor(result: ToolPermissionResult): readonly OptionKind[] {
  if (result.behavior === 'deny') {
    return ['reject_once', 'reject_always'];
  }
  return result.scope === 'session'
    ? ['allow_always', 'allow_once']
    : ['allow_once', 'allow_always'];
}

export interface PermissionAnswer {
  readonly outcome: RequestPermissionOutcome;
  /** The decision also stops the turn, so the runtime sends session/cancel. */
  readonly cancelTurn: boolean;
}

/** The ACP option for a decision, falling back to the nearest one the agent offered. */
export function permissionAnswer(
  result: ToolPermissionResult,
  options: readonly PermissionOption[],
): PermissionAnswer {
  if (result.behavior === 'deny' && result.interrupt === true) {
    return { outcome: { outcome: 'cancelled' }, cancelTurn: true };
  }
  for (const kind of kindsFor(result)) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option !== undefined) {
      return { outcome: { outcome: 'selected', optionId: option.optionId }, cancelTurn: false };
    }
  }
  return { outcome: { outcome: 'cancelled' }, cancelTurn: false };
}
