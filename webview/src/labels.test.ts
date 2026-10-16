import { describe, expect, it } from 'vitest';

import { isSurface, STATE_INFO, STATE_RANK, SURFACE_LABELS, SURFACES } from './labels.js';

describe('labels', () => {
  it('has a label for every surface', () => {
    expect(SURFACES.map((surface) => SURFACE_LABELS[surface])).toStrictEqual([
      'CLI',
      'SDK',
      'Overlord',
      'Desktop',
      'Cowork',
      'Cloud',
      'claude.ai',
    ]);
  });

  it('isSurface accepts known surfaces only', () => {
    expect(isSurface('cowork')).toBe(true);
    expect(isSurface('mainframe')).toBe(false);
    expect(isSurface(3)).toBe(false);
  });

  it('gives every state a glyph and ranks waiting first', () => {
    expect(STATE_INFO.failed).toStrictEqual({ label: 'failed', icon: '✕', tone: 'critical' });
    expect(STATE_RANK.waiting).toBeLessThan(STATE_RANK.running);
    expect(STATE_RANK.running).toBeLessThan(STATE_RANK.done);
  });
});
