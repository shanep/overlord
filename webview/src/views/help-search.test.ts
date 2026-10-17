import { describe, expect, it } from 'vitest';

import { queryWords, searchHelp } from './help-search.js';

/** A small help page: one section with an intro, a table and an h3 group, and one plain section. */
function page(): HTMLElement {
  const root = document.createElement('article');
  root.innerHTML = `
    <section class="help-section" aria-labelledby="states">
      <h2 id="states">Session states</h2>
      <p>Every session shows one of these.</p>
      <table><tbody>
        <tr><td>running</td><td>Working on a turn</td></tr>
        <tr><td>waiting</td><td>Needs your answer</td></tr>
      </tbody></table>
      <h3>Markers</h3>
      <p>Small arrows on a row.</p>
      <ol><li>Collapsed</li><li>Expanded</li></ol>
    </section>
    <section class="help-section" aria-labelledby="config">
      <h2 id="config">Config badges</h2>
      <p>Where an item lives.</p>
    </section>`;
  return root;
}

function shownText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[hidden]')) {
    hidden.remove();
  }
  return copy.textContent.replaceAll(/\s+/gu, ' ').trim();
}

describe('queryWords', () => {
  it('lowercases and splits on whitespace', () => {
    expect(queryWords(' Stop\tThe\nFleet ')).toStrictEqual(['stop', 'the', 'fleet']);
    expect(queryWords(' \t ')).toStrictEqual([]);
  });
});

describe('searchHelp', () => {
  it('keeps only the rows that hold every word', () => {
    const root = page();
    expect([...searchHelp(root, 'needs ANSWER')]).toStrictEqual(['states']);
    const text = shownText(root);
    expect(text).toContain('Needs your answer');
    expect(text).toContain('Every session shows one of these.');
    expect(text).not.toContain('Working on a turn');
    expect(text).not.toContain('Markers');
    expect(text).not.toContain('Config badges');
  });

  it('keeps a whole group when its heading or prose matches', () => {
    const root = page();
    searchHelp(root, 'arrows');
    const text = shownText(root);
    expect(text).toContain('Collapsed');
    expect(text).toContain('Expanded');
    expect(text).not.toContain('Working on a turn');
  });

  it('keeps a whole section when its heading matches', () => {
    const root = page();
    searchHelp(root, 'session states');
    expect(shownText(root)).toContain('Working on a turn');
  });

  it('shows everything again when the query is cleared', () => {
    const root = page();
    expect(searchHelp(root, 'nothing like this').size).toBe(0);
    expect([...searchHelp(root, '')]).toStrictEqual(['states', 'config']);
    expect(root.querySelectorAll('[hidden]')).toHaveLength(0);
  });
});
