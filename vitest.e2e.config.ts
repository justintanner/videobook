import { defineConfig } from 'vitest/config';
import path from 'node:path';

const BENIGN_TEST_CONSOLE_PREFIXES = [
  '[mcp] ',
] as const;

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
    // Same silencing policy as the root suite (vb-2ky4.5).
    silent: 'passed-only',
    onConsoleLog(log) {
      return !BENIGN_TEST_CONSOLE_PREFIXES.some((prefix) => log.startsWith(prefix));
    },
    testTimeout: 600_000,
    hookTimeout: 30_000,
  },
});
