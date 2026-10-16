// The frustration view. Owned by the frustration work; this stub keeps the
// build green until that lands.

import type { FrustrationState } from '../../../shared/protocol.js';
import type { Runtime } from '../runtime.js';

export const EMPTY_FRUSTRATION: FrustrationState = {
  totalPrompts: 0,
  atClaude: 0,
  general: 0,
  byDay: [],
  bySession: [],
  topTerms: [],
  recent: [],
  scannedAt: null,
};

export function buildFrustration(_rt: Runtime): FrustrationState {
  return EMPTY_FRUSTRATION;
}
