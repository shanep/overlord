// Setting a session's token budget from its Fleet row. The Fleet warns once
// when the session uses it up.

import { sessionName } from '../../shared/model.js';
import { usedTokens } from '../progress/fleet-progress.js';
import { tokens } from '../tuning/words.js';

import type { ActionHandlers } from './action-types.js';
import type { Runtime } from './runtime.js';

const SCALES: Readonly<Record<string, number>> = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
};

/**
 * Tokens from text like 500M, 1.5b, 200k or 250000, ignoring spaces, commas
 * and underscores. Null for anything else, and for zero.
 */
export function parseTokens(text: string): number | null {
  const cleaned = text.toLowerCase().replaceAll(/[\s,_]/gu, '');
  const scale = SCALES[cleaned.slice(-1)];
  const digits = scale === undefined ? cleaned : cleaned.slice(0, -1);
  if (!/^[\d.]+$/u.test(digits)) {
    return null;
  }
  const value = Math.round(Number(digits) * (scale ?? 1));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Asks for a session's budget and saves it. Empty clears it. */
export async function askBudget(rt: Runtime, sessionId: string): Promise<void> {
  const session = rt.store.fleetState(rt.clock()).sessions.find((item) => item.id === sessionId);
  const name = session === undefined ? 'this session' : sessionName(session);
  const used =
    session === undefined ? '' : ` It has used ${tokens(usedTokens(session.usage))} so far.`;
  const current = rt.budgets.get(sessionId);
  const answer = await rt.host.inputBox({
    prompt: `Token budget for ${name}, such as 500M. Leave it empty for none.${used}`,
    value: current === null ? '' : tokens(current),
  });
  if (answer === null) {
    return;
  }
  if (answer.trim() === '') {
    await rt.budgets.set(sessionId, null);
    return;
  }
  const amount = parseTokens(answer);
  if (amount === null) {
    rt.host.showWarning(`"${answer}" is not a token amount. Try something like 500M or 2B.`);
    return;
  }
  await rt.budgets.set(sessionId, amount);
}

export const budgetActions: ActionHandlers<'setBudget'> = {
  setBudget: async ({ rt }, action) => {
    await askBudget(rt, action.sessionId);
  },
};
