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
      'extension/src/url-target.test.ts',
      'extension/src/x-post-target.test.ts',
      'src/videobook/notebook-draft.test.ts',
      'src/videobook/notebook-grid.test.ts',
      'src/videobook/notebook-routing.test.ts',
      'src/videobook/notebook-run-watch.test.ts',
      'src/videobook/notebook-cell-presentation.test.ts',
      'src/videobook/notebook-coordinate-actions.test.ts',
      'src/videobook/command-plan.test.ts',
      'src/videobook/mvp-gates.test.ts',
      'src/videobook/search-benchmark-corpus.test.ts',
      'server/src/archive-store.test.ts',
      'server/src/archive-b2.test.ts',
      'server/src/audio-cue.test.ts',
      'server/src/audio-sync.test.ts',
      'server/src/character-name.test.ts',
      'server/src/elevenlabs-audio-extension.test.ts',
      'server/src/env-secrets.test.ts',
      'server/src/ffmpeg.test.ts',
      'server/src/fs.test.ts',
      'server/src/generation-registry.test.ts',
      'server/src/chat-router.test.ts',
      'server/src/chat-models.test.ts',
      'server/src/dialog-quality.test.ts',
      'server/src/google-flow-cost.test.ts',
      'server/src/google-flow-refs.test.ts',
      'server/src/image.test.ts',
      'server/src/image-models.test.ts',
      'server/src/job-deadline.test.ts',
      'server/src/lazy-render.test.ts',
      'server/src/jobs/**/*.test.ts',
      'server/src/keyword-placement-cache.test.ts',
      'server/src/openai-intelligence.test.ts',
      'server/src/remotion-cancellation.test.ts',
      'server/src/remotion/constants.test.ts',
      'server/src/remotion/keyword-graphics.test.ts',
      'server/src/remotion/keyword-placement.test.ts',
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
      'server/src/queue.test.ts',
      'server/src/video-models.test.ts',
      'server/src/watermark-config.test.ts',
      'server/src/x/authenticated-handle.test.ts',
      'server/src/x/post-to-x.test.ts',
      'server/src/x/x-tokens.test.ts',
      'server/src/zod-slots.test.ts',
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
