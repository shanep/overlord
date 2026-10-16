// The stylesheets ship inside main.js and are added as one <style> element,
// so the host only has to load one file. The webview CSP allows inline styles.

export const STYLE_ID = 'overlord-theme';

/**
 * Add `sheets`, in order, to the document head as one style element. A later
 * call replaces the earlier text, so pass every sheet in a single call.
 */
export function injectStyles(sheets: readonly string[], target: Document): HTMLStyleElement {
  const css = sheets.join('\n');
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
