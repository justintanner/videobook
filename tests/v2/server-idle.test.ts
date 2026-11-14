import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { testBudget } from '../../server/src/test-budget.js'

it('keeps idle queue polls out of database transactions across several books without a client', async () => {
  const home = await mkdtemp(join(tmpdir(), 'videobook-idle-'))
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', 'tsx', 'tests/v2/server-idle-fixture.mjs',
    ], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        VIDEOBOOK_HOME: home,
        VIDEOBOOK_TEST_TIME_SCALE: process.env.VIDEOBOOK_TEST_TIME_SCALE,
      },
      timeout: testBudget(60_000),
    })
    const resultLine = stdout.split('\n').find(line => line.startsWith('IDLE_RESULT '))
    expect(resultLine, stdout).toBeDefined()
    const result = JSON.parse(resultLine!.slice('IDLE_RESULT '.length)) as {
      books: number
      startupTransactions: number
      idleTransactions: number
    }
    expect(result.books).toBe(4)
    expect(result.startupTransactions).toBeGreaterThan(0)
    expect(result.idleTransactions).toBe(0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, testBudget(90_000))
