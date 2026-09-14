import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/v2/voice-chat.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 90_000,
    silent: 'passed-only',
  },
})
