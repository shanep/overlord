import { describe, expect, it } from 'vitest';

import type { InjectFacet } from '../talk-types.js';
import { INJECT_ORDER, injectRoute } from '../talk-types.js';

import { claudeInject } from './inject.js';

describe('claudeInject', () => {
  it('prefers the hook, then the launch argument', () => {
    expect(INJECT_ORDER).toStrictEqual(['hook', 'launch-argument', 'first-prompt']);
    expect(injectRoute(claudeInject, { hooks: true, launching: true })).toBe('hook');
    expect(injectRoute(claudeInject, { hooks: false, launching: true })).toBe('launch-argument');
    expect(injectRoute(claudeInject, { hooks: false, launching: false })).toBeNull();
  });

  it('appends to the system prompt at launch', () => {
    expect(claudeInject.launchArgs?.('note')).toStrictEqual(['--append-system-prompt', 'note']);
  });
});

describe('injectRoute', () => {
  it('falls back to a first prompt prefix for an agent with nothing else', () => {
    const prompt: InjectFacet = {
      routes: ['first-prompt'],
      promptPrefix: (text, first) => `${text}\n\n${first}`,
    };
    expect(injectRoute(prompt, { hooks: true, launching: true })).toBe('first-prompt');
    expect(injectRoute(prompt, { hooks: true, launching: false })).toBeNull();
  });

  it('skips a route the facet lists without the function for it', () => {
    expect(
      injectRoute({ routes: ['launch-argument'] }, { hooks: true, launching: true }),
    ).toBeNull();
  });
});
