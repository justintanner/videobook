import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    fileParallelism: false,
    include: ['**/*.e2e.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 30_000,
  },
});
