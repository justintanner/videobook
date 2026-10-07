import { defineConfig } from 'vitest/config'
import e2eConfig from './vitest.e2e.config'

if (process.env.VIDEOBOOK_RUN_MODEL_E2E !== '1') throw new Error('Set VIDEOBOOK_RUN_MODEL_E2E=1 to explicitly run the paid goal test')

export default defineConfig({
  ...e2eConfig,
  test: {
    ...e2eConfig.test,
    include: ['tests/v2/goal-ui.e2e.test.ts'],
    setupFiles: [],
    fileParallelism: false,
    maxWorkers: 1,
    silent: false,
  },
})
