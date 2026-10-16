// Shared setup for webview component tests.
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout, so give elements a size and let charts measure text
// without a canvas (ECharts falls back to an estimate when there is none).
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 640 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 240 });
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: (): null => null,
});

afterEach(() => {
  cleanup();
});
