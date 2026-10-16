// Shared setup for webview component tests.
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout, so give elements a size and let charts measure text
// without a canvas (ECharts falls back to an estimate when there is none).
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 640 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 240 });
// jsdom does not scroll either, so scrollIntoView is a no-op tests can spy on.
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  writable: true,
  value: (): void => undefined,
});
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: (): null => null,
});

afterEach(() => {
  cleanup();
});
