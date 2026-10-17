import { describe, expect, it } from 'vitest';

import { backendOf, BOISESTATE_MODEL_IDS } from './backends.js';

describe('backendOf', () => {
  it('reads every boisestate.ai model id as the bridge', () => {
    for (const id of BOISESTATE_MODEL_IDS) {
      expect(backendOf(id)).toBe('boisestate');
    }
  });

  it('reads Anthropic model ids and a missing model as Anthropic', () => {
    expect(backendOf('claude-opus-5-5')).toBe('anthropic');
    expect(backendOf('claude-sonnet-5-5[1m]')).toBe('anthropic');
    expect(backendOf(null)).toBe('anthropic');
  });
});
