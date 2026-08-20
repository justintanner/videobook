import { defineConfig, configDefaults } from 'vitest/config';
import path from 'node:path';

// Benign prefixes stripped even from failing-test console output.
// Keep this list tiny so real diagnostics stay visible.
const BENIGN_TEST_CONSOLE_PREFIXES = [
  '[mcp] ',
] as const;

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
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: [
        'src/**/*.{ts,tsx}',
        'server/src/**/*.ts',
        'extension/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.e2e.test.ts',
        '**/*.d.ts',
      ],
    },
    globalSetup: ['./vitest.global-setup.ts'],
    // Bounded file parallelism: 4 workers on typical 10-logical-core hosts.
    // Each worker already isolates VIDEOBOOK_LIBRARY_DIR / APP_STATE via
    // vitest.setup.ts (VITEST_POOL_ID + UUID). E2E uses its own worker policy.
    fileParallelism: true,
    maxWorkers: 4,
    include: [
      'tests/v2/**/*.test.ts',
      'tests/dolt-native-cutover.test.ts',
      'extension/src/url-target.test.ts',
      'extension/src/mcp.test.ts',
      'extension/src/x-post-target.test.ts',
      'src/videobook/notebook-draft.test.ts',
      'src/videobook/notebook-grid.test.ts',
      'src/videobook/last-work-slot.test.ts',
      'src/videobook/notebook-routing.test.ts',
      'src/videobook/notebook-run-watch.test.ts',
      'src/videobook/media-insight-watch.test.ts',
      'src/videobook/media-insights.test.ts',
      'src/videobook/notebook-cell-presentation.test.ts',
      'src/videobook/notebook-cell-add-menu.test.ts',
      'src/videobook/notebook-coordinate-actions.test.ts',
      'src/videobook/notebook-video-axis-arrange.test.ts',
      'src/videobook/command-plan.test.ts',
      'scripts/search-benchmark-corpus.test.ts',
      'src/videobook/watermark-target.test.ts',
      'server/src/app-state.test.ts',
      'server/src/engine-rename.test.ts',
      'server/src/archive-store.test.ts',
      'server/src/test-media-fixtures.test.ts',
      'server/src/test-clock-inventory.test.ts',
      'server/src/jobs/asset-file-helpers.test.ts',
      'server/src/artifact-label.test.ts',
      'server/src/archive-b2.test.ts',
      'server/src/audio-cue.test.ts',
      'server/src/audio-sync.test.ts',
      'server/src/character-name.test.ts',
      'server/src/content-store.test.ts',
      'server/src/elevenlabs-audio-extension.test.ts',
      'server/src/env-secrets.test.ts',
      'server/src/ffmpeg.test.ts',
      'server/src/frame-utils.test.ts',
      'server/src/fs.test.ts',
      'server/src/generation-registry.test.ts',
      'server/src/chat-router.test.ts',
      'server/src/chat-models.test.ts',
      'server/src/dialog-quality.test.ts',
      'server/src/google-flow-cost.test.ts',
      'server/src/google-flow-refs.test.ts',
      'server/src/image.test.ts',
      'server/src/image-models.test.ts',
      'server/src/http-byte-range.test.ts',
      'server/src/job-deadline.test.ts',
      'server/src/lazy-render.test.ts',
      'server/src/logger.test.ts',
      'server/src/local-search-models.test.ts',
      'server/src/jobs/**/*.test.ts',
      'server/src/keyword-placement-cache.test.ts',
      'server/src/openai-intelligence.test.ts',
      'server/src/osg-placement-cache.test.ts',
      'server/src/remotion-cancellation.test.ts',
      'server/src/remotion/constants.test.ts',
      'server/src/remotion/keyword-graphics.test.ts',
      'server/src/remotion/keyword-placement.test.ts',
      'server/src/remotion/osg-spec.test.ts',
      'server/src/remotion/qr-outro-spec.test.ts',
      'server/src/remotion/subtitles/chunker.test.ts',
      'server/src/remotion/subtitles/segments.test.ts',
      'server/src/remotion/util.test.ts',
      'server/src/time-parse.test.ts',
      'server/src/timewarp.test.ts',
      'server/src/tools/**/*.test.ts',
      'server/src/scheduled-posts.test.ts',
      'server/src/screenshot.test.ts',
      'server/src/payload-builders.test.ts',
      'server/src/notebook-reference-resolver.test.ts',
      'server/src/provider-prompt-transform.test.ts',
      'server/src/preview-payload.test.ts',
      'server/src/queue.test.ts',
      'server/src/queue-shutdown.test.ts',
      'server/src/video-models.test.ts',
      'server/src/video-proxy.test.ts',
      'server/src/vitest-quiet-policy.test.ts',
      'server/src/vision-regions.test.ts',
      'server/src/watermark-badge.test.ts',
      'server/src/watermark-config.test.ts',
      'server/src/x/authenticated-handle.test.ts',
      'server/src/x/post-to-x.test.ts',
      'server/src/x/x-tokens.test.ts',
      'server/src/zod-slots.test.ts',
    ],
    exclude: ['**/*.e2e.test.ts', '**/*.spec.ts', 'server/dist/**', ...configDefaults.exclude],
    setupFiles: ['./vitest.setup.ts'],
    // Hide console output from passing tests. Failing tests still print
    // logs; onConsoleLog only strips a tiny allowlist of known-benign lines.
    silent: 'passed-only',
    onConsoleLog(log) {
      return !BENIGN_TEST_CONSOLE_PREFIXES.some((prefix) => log.startsWith(prefix));
    },
    testTimeout: 30_000,
    // Per-test afterEach now waits for leaked jobs (vb-2ky4.4) instead of
    // letting the next beforeEach absorb a 30–60s runner drain.
    hookTimeout: 15_000,
  },
});
