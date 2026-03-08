import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/*.e2e.test.ts', 'server/dist/**', ...configDefaults.exclude],
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
});
