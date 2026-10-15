import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// One bundle for every Overlord view. The host picks the view at load time.
export default defineConfig({
  root: 'webview',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: 'webview/index.html',
      output: {
        entryFileNames: 'main.js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
