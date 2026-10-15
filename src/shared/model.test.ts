import { describe, expect, it } from 'vitest';

import { ZERO_USAGE } from './model.js';

describe('ZERO_USAGE', () => {
  it('has every counter at zero', () => {
    expect(ZERO_USAGE).toStrictEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      thinking: 0,
    });
  });
});
