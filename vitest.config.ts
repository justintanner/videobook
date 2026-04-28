import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/*.e2e.test.ts', '**/*.spec.ts', 'server/dist/**', ...configDefaults.exclude],
    testTimeout: 30_000,
    // Generous hookTimeout so beforeEach can absorb the prior test's runner
    // drain (process_video + analyze_video can stay in-flight after a test
    // ends because upload_file is fire-and-forget); 15s wasn't enough on a
    // loaded CI machine.
    hookTimeout: 30_000,
  },
});
