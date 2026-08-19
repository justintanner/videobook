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
    // Independent of the root suite: Chromium + FFmpeg E2E files contend for
    // GPU/CPU, so cap at 2 local workers rather than inheriting root maxWorkers=4.
    fileParallelism: true,
    maxWorkers: 2,
    include: [
      'tests/v2/**/*.e2e.test.ts',
      'server/src/**/*.e2e.test.ts',
    ],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 30_000,
  },
});
