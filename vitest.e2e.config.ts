import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    fileParallelism: false,
    include: [
      'tests/v2/**/*.e2e.test.ts',
      'server/src/**/*.e2e.test.ts',
    ],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 30_000,
  },
});
