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
    expect(STATE_INFO.failed).toStrictEqual({
      label: 'failed',
      icon: '✕',
      tone: 'critical',
      description: 'Ended with an error.',
    });
    expect(STATE_RANK.waiting).toBeLessThan(STATE_RANK.running);
    expect(STATE_RANK.running).toBeLessThan(STATE_RANK.done);
  });

  it('describes every state for the hover tooltip', () => {
    const descriptions = Object.values(STATE_INFO).map((info) => info.description);
    expect(descriptions.every((text) => text.length > 0)).toBe(true);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    expect(STATE_INFO.unknown.description).toContain('transcript');
  });
});
