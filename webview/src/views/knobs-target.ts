// Which agent the Knobs view edits, and the layers it may save to, so every
// save and remove deep in the view names the same agent without threading
// it through each row.

import { createContext, useContext } from 'react';

import type { AgentId } from '../../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../../src/shared/agents.js';
import type { EditableLayer } from '../../../src/shared/protocol.js';

import { EDITABLE_LAYERS } from './knobs-values.js';

export interface KnobsTarget {
  readonly agent: AgentId;
  /** The layers the agent's knobs can be saved to, in the order the pick lists them. */
  readonly layers: readonly EditableLayer[];
}

/** Claude Code with all three layers, which is what the view edited before there were others. */
const CLAUDE_TARGET: KnobsTarget = { agent: CLAUDE_CODE, layers: EDITABLE_LAYERS };

export const KnobsTargetContext = createContext<KnobsTarget>(CLAUDE_TARGET);

export function useKnobsTarget(): KnobsTarget {
  return useContext(KnobsTargetContext);
}
