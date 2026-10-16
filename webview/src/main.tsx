import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App, readViewId } from './app.js';
import { injectStyles } from './styles.js';
import css from './theme.css?inline';
import { createVsCodeApi } from './vscode-api.js';
import { VsCodeProvider } from './vscode-context.js';

injectStyles(css, document);

const root = document.querySelector<HTMLElement>('#root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <VsCodeProvider api={createVsCodeApi()}>
        <App view={readViewId(root) ?? 'fleet'} />
      </VsCodeProvider>
    </StrictMode>,
  );
}
