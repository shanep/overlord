// HTML shell for an Overlord webview. The host passes in webview URIs as
// strings so this stays free of vscode imports and easy to test.

import type { ViewId } from '../shared/protocol.js';

export interface WebviewHtmlInput {
  readonly view: ViewId;
  readonly title: string;
  /** webview.cspSource */
  readonly cspSource: string;
  readonly scriptUri: string;
  readonly styleUri: string | null;
  readonly nonce: string;
}

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A 32 character nonce from the given random source (crypto.getRandomValues in the host). */
export function makeNonce(fill: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = fill(new Uint8Array(32));
  let nonce = '';
  for (const byte of bytes) {
    nonce += NONCE_CHARS.charAt(byte % NONCE_CHARS.length);
  }
  return nonce;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    // ECharts and React set inline styles on chart and layout elements.
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

export function buildWebviewHtml(input: WebviewHtmlInput): string {
  const csp = contentSecurityPolicy(input.cspSource, input.nonce);
  const style =
    input.styleUri === null
      ? ''
      : `\n    <link rel="stylesheet" href="${escapeAttribute(input.styleUri)}" />`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeAttribute(input.title)}</title>${style}
  </head>
  <body>
    <div id="root" data-view="${input.view}"></div>
    <script type="module" nonce="${input.nonce}" src="${escapeAttribute(input.scriptUri)}"></script>
  </body>
</html>
`;
}
