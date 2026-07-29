import { defineConfig, configDefaults } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // Mirror vite.config.ts's `@` → src alias so tests can import src modules
  // (and modules that themselves import via `@/`). vitest.config.ts is a
  // standalone config and does not inherit vite.config.ts's resolve settings.
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    fileParallelism: false,
    include: [
      'tests/v2/**/*.test.ts',
      'tests/dolt-native-cutover.test.ts',
      'src/videobook/notebook-draft.test.ts',
      'src/videobook/notebook-grid.test.ts',
      'src/videobook/notebook-routing.test.ts',
      'src/videobook/command-plan.test.ts',
      'src/videobook/mvp-gates.test.ts',
      'src/videobook/search-benchmark-corpus.test.ts',
      'server/src/archive-store.test.ts',
      'server/src/jobs/archive-clip.test.ts',
      'server/src/openai-intelligence.test.ts',
      'server/src/tools/log-wrapper.test.ts',
      'server/src/scheduled-posts.test.ts',
    ],
    exclude: ['**/*.e2e.test.ts', '**/*.spec.ts', 'server/dist/**', ...configDefaults.exclude],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    // Generous hookTimeout so beforeEach can absorb the prior test's runner
    // drain (process_video + analyze_video can stay in-flight after a test
    // ends because upload_file is fire-and-forget); 15s wasn't enough on a
    // loaded CI machine, 30s tipped over once apply_cuts / apply_sfx joined.
    hookTimeout: 60_000,
  },
});
