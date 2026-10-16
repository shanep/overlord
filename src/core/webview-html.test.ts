import { describe, expect, it } from 'vitest';

import { buildWebviewHtml, contentSecurityPolicy, makeNonce } from './webview-html.js';

describe('makeNonce', () => {
  it('maps each random byte onto the nonce alphabet', () => {
    const nonce = makeNonce((bytes) => bytes.map((_, index) => index));
    expect(nonce).toHaveLength(32);
    expect(nonce.slice(0, 3)).toBe('ABC');
    expect(nonce.at(-1)).toBe('f');
  });

  it('wraps bytes past the alphabet length', () => {
    expect(makeNonce((bytes) => bytes.fill(62))).toBe('A'.repeat(32));
    expect(makeNonce((bytes) => bytes.fill(61))).toBe('9'.repeat(32));
  });
});

describe('contentSecurityPolicy', () => {
  it('allows only the nonce script and webview resources', () => {
    expect(contentSecurityPolicy('vscode-resource:', 'n1')).toBe(
      "default-src 'none'; img-src vscode-resource: data:; style-src vscode-resource: 'unsafe-inline'; font-src vscode-resource:; script-src 'nonce-n1'",
    );
  });
});

describe('buildWebviewHtml', () => {
  const base = {
    view: 'fleet',
    title: 'Overlord <Fleet> & "more"',
    cspSource: 'vscode-resource:',
    scriptUri: 'https://file/main.js?a=1&b=2',
    nonce: 'abc',
  } as const;

  it('sets the view, nonce, script and escaped title', () => {
    const html = buildWebviewHtml({ ...base, styleUri: null });
    expect(html).toContain('<div id="root" data-view="fleet" data-layout="panel"></div>');
    expect(html).toContain(
      '<script type="module" nonce="abc" src="https://file/main.js?a=1&amp;b=2"></script>',
    );
    expect(html).toContain('<title>Overlord &lt;Fleet&gt; &amp; &quot;more&quot;</title>');
    expect(html).toContain(`content="default-src 'none'; img-src vscode-resource: data:;`);
    expect(html).not.toContain('<link');
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  it('marks the sidebar layout', () => {
    const html = buildWebviewHtml({ ...base, styleUri: null, layout: 'sidebar' });
    expect(html).toContain('<div id="root" data-view="fleet" data-layout="sidebar"></div>');
  });

  it('links the stylesheet when there is one', () => {
    const html = buildWebviewHtml({ ...base, styleUri: 'https://file/main.css' });
    expect(html).toContain('<link rel="stylesheet" href="https://file/main.css" />');
  });
});
