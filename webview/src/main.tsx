import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App, readViewId } from './app.js';
import { SHEETS } from './css/sheets.js';
import fleetCss from './fleet.css?inline';
import reputationCss from './reputation.css?inline';
import sidebarCss from './sidebar.css?inline';
import { injectStyles } from './styles.js';
import { createVsCodeApi } from './vscode-api.js';
import { VsCodeProvider } from './vscode-context.js';

injectStyles([...SHEETS, fleetCss, reputationCss, sidebarCss], document);

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
