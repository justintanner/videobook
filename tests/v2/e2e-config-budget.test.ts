import { afterEach, describe, expect, it, vi } from 'vitest'

async function e2eTest(scale: string) {
  vi.stubEnv('VIDEOBOOK_TEST_TIME_SCALE', scale)
  vi.resetModules()
  const { default: config } = await import('../../vitest.e2e.config')
  return config.test
}

describe('e2e vitest config budgets', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('scales the 30 s hook budget with the test time scale and hands the scale to e2e workers', async () => {
    expect(await e2eTest('3')).toMatchObject({ hookTimeout: 90_000, testTimeout: 600_000, env: { VIDEOBOOK_TEST_TIME_SCALE: '3' } })
    expect(await e2eTest('1')).toMatchObject({ hookTimeout: 30_000, testTimeout: 600_000, env: { VIDEOBOOK_TEST_TIME_SCALE: '1' } })
  })
})
