import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
          environment: 'node',
          restoreMocks: true,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'webview',
          include: ['webview/**/*.test.ts', 'webview/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['webview/test/setup.ts'],
          restoreMocks: true,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: [
        'src/core/**/*.ts',
        'src/shared/**/*.ts',
        'src/hook/**/*.ts',
        'webview/src/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        '**/test-helpers/**',
        // Entry points only wire real I/O together. Integration tests cover them.
        'src/hook/main.ts',
        'webview/src/main.tsx',
      ],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
