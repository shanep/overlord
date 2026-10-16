// The stylesheet ships inside main.js and is added as a <style> element, so
// the host only has to load one file. The webview CSP allows inline styles.

export const STYLE_ID = 'overlord-theme';

/** Add `css` to the document head once. Returns the style element. */
export function injectStyles(css: string, target: Document): HTMLStyleElement {
  const existing = target.querySelector(`#${STYLE_ID}`);
  if (existing instanceof HTMLStyleElement) {
    existing.textContent = css;
    return existing;
  }
  const style = target.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  target.head.append(style);
  return style;
}
