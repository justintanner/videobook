import { defineConfig } from 'vitest/config'

// Live image-edit adapter submissions against KIE and FAL. No vitest.setup.ts:
// the shared guard scrubs provider keys and blocks outbound fetch, which would
// defeat the point. Gate on real provider keys before running; consumes credits.
export default defineConfig({
  test: {
    include: ['server/src/jobs/_image-edit-adapter.e2e.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 600_000,
    hookTimeout: 90_000,
    silent: 'passed-only',
  },
})
