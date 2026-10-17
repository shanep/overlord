import { describe, expect, it } from 'vitest';

import { ACHIEVEMENTS } from './achievements.js';
import { MAX_ACHIEVEMENTS } from './leaderboard.js';

describe('ACHIEVEMENTS', () => {
  it('fits in what one leaderboard upload may carry', () => {
    expect(ACHIEVEMENTS.length).toBeLessThanOrEqual(MAX_ACHIEVEMENTS);
  });
});
