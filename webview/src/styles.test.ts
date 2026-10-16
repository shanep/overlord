import { afterEach, describe, expect, it } from 'vitest';

import { injectStyles, STYLE_ID } from './styles.js';

describe('injectStyles', () => {
  afterEach(() => {
    document.querySelector(`#${STYLE_ID}`)?.remove();
  });

  it('adds one style element and updates it on a second call', () => {
    const first = injectStyles('body { color: red; }', document);
    expect(first.parentElement).toBe(document.head);
    expect(first.textContent).toBe('body { color: red; }');
    const second = injectStyles('body { color: blue; }', document);
    expect(second).toBe(first);
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);
    expect(second.textContent).toBe('body { color: blue; }');
  });
});
