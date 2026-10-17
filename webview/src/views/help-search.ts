// Search on the help page. The page is hand built from tables, cards and
// diagrams, so the search works on what was rendered: it hides the sections,
// groups and rows that do not hold every word of the query, and marks the
// words it found. A section whose heading matches stays whole, and so does a
// group (an h3 with what follows it) whose heading or prose matches.

/** Set on everything the search hid, so the next search can show it again. */
const HIDDEN_MARK = 'data-search-hidden';
const HIDDEN_SELECTOR = '[data-search-hidden]';

/** The name the found words are marked with, styled in theme.css. */
const HIGHLIGHT_NAME = 'help-search';

/** The lowercase words of a query, empty when there is nothing to search for. */
export function queryWords(query: string): readonly string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

function holdsAll(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.every((word) => lower.includes(word));
}

function matches(element: Element, words: readonly string[]): boolean {
  return holdsAll(element.textContent, words);
}

function hide(element: Element): void {
  element.setAttribute('hidden', '');
  element.setAttribute(HIDDEN_MARK, '');
}

function showAll(root: Element): void {
  for (const element of root.querySelectorAll(HIDDEN_SELECTOR)) {
    element.removeAttribute('hidden');
    element.removeAttribute(HIDDEN_MARK);
  }
}

/** The pieces a list or table filters one by one, or null for a single item. */
function rowsOf(element: Element): readonly Element[] | null {
  if (element instanceof HTMLTableElement) {
    return [...element.querySelectorAll(':scope > tbody > tr')];
  }
  if (element instanceof HTMLOListElement || element instanceof HTMLUListElement) {
    return [...element.children];
  }
  return null;
}

/** Hides what in `element` misses the query and says whether anything is left. */
function filterItem(element: Element, words: readonly string[]): boolean {
  const rows = rowsOf(element);
  if (rows === null) {
    if (matches(element, words)) {
      return true;
    }
    hide(element);
    return false;
  }
  let kept = false;
  for (const row of rows) {
    if (matches(row, words)) {
      kept = true;
    } else {
      hide(row);
    }
  }
  if (!kept) {
    hide(element);
  }
  return kept;
}

/** Splits a section's children into groups, each starting at an h3. */
function groupsOf(section: Element): readonly (readonly Element[])[] {
  const groups: Element[][] = [[]];
  for (const child of section.children) {
    if (child.tagName === 'H2') {
      continue;
    }
    if (child.tagName === 'H3') {
      groups.push([]);
    }
    groups.at(-1)?.push(child);
  }
  return groups.filter((group) => group.length > 0);
}

/** Prose and headings explain a group, while tables, lists and diagrams are what it holds. */
function isProse(element: Element): boolean {
  return element.tagName === 'H3' || element.tagName === 'P';
}

/** Filters one group and says whether any of it is left. */
function filterGroup(group: readonly Element[], words: readonly string[]): boolean {
  const prose = group.filter((element) => isProse(element));
  if (holdsAll(prose.map((element) => element.textContent).join(' '), words)) {
    return true;
  }
  const items = group.filter((element) => !isProse(element));
  let kept = false;
  for (const item of items) {
    kept = filterItem(item, words) || kept;
  }
  if (!kept) {
    for (const element of prose) {
      hide(element);
    }
  }
  return kept;
}

function filterSection(section: Element, words: readonly string[]): boolean {
  if (!matches(section, words)) {
    hide(section);
    return false;
  }
  const heading = section.querySelector(':scope > h2');
  if (heading !== null && matches(heading, words)) {
    return true;
  }
  let kept = false;
  for (const group of groupsOf(section)) {
    kept = filterGroup(group, words) || kept;
  }
  if (!kept) {
    hide(section);
  }
  return kept;
}

/** Ranges over every place a word shows in the text left visible under `root`. */
function wordRanges(root: Element, words: readonly string[]): readonly Range[] {
  const ranges: Range[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest('[hidden]')) {
      continue;
    }
    const text = (node.textContent ?? '').toLowerCase();
    for (const word of words) {
      for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) {
        const range = root.ownerDocument.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

/** Marks the found words, where the browser can (jsdom and old engines cannot). */
function highlight(root: Element, words: readonly string[]): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') {
    return;
  }
  if (words.length === 0) {
    CSS.highlights.delete(HIGHLIGHT_NAME);
    return;
  }
  CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...wordRanges(root, words)));
}

/**
 * Shows only the parts of the help page under `root` that match `query`, and
 * returns the ids of the sections left showing. An empty query shows it all.
 */
export function searchHelp(root: Element, query: string): ReadonlySet<string> {
  showAll(root);
  const words = queryWords(query);
  const shown = new Set<string>();
  for (const section of root.querySelectorAll('.help-section')) {
    if (words.length === 0 || filterSection(section, words)) {
      const id = section.getAttribute('aria-labelledby');
      if (id !== null) {
        shown.add(id);
      }
    }
  }
  highlight(root, words);
  return shown;
}
