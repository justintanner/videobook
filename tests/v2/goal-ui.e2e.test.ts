import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { GoalSnapshot } from '../../server/src/tools/goal.js'
import { availablePort, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

describe('goal mode in the browser', () => {
  let root = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser
  let page: Page
  let client: Client
  let bookId = ''
  let notebookId = ''
  let appUrl = ''
  const errors: string[] = []
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(await client.callTool({ name, arguments: { book_id: bookId, notebook_id: notebookId, ...args } })) as T
  const goals = () => call<{ goals: GoalSnapshot[] }>('video_goal', { action: 'list' })
  const status = () => page.locator('.goal-status-button')
  const panel = () => page.locator('.goal-panel')
  const tiles = () => page.locator('.cell-kind-goal')
  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-goal-ui-'))
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    const env = {
      ...process.env, PORT: String(port), OPENAI_API_KEY: 'test-goal-browser', KIE_API_KEY: 'test-goal-browser',
      VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json'),
    }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'goal-ui-e2e', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    bookId = (await call<{ bookId: string }>('create_book', { name: 'goal-ui' })).bookId
    notebookId = (await call<Array<{ id: string }>>('list_notebooks'))[0]!.id
    const vitePort = await availablePort()
    appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
    })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(30_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }, 30_000)

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && process.env.VIDEOBOOK_GOAL_SCREENSHOTS) {
      await page.screenshot({ path: join(process.env.VIDEOBOOK_GOAL_SCREENSHOTS, 'goal-failure.png') })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
  })

  it('saves the plan in a goal tile, edits it from the chat input and keeps the message row on one line', async () => {
    const saved = await call<GoalSnapshot>('video_goal', {
      action: 'create', brief: 'A funny dog on a skateboard, multiple 10s clips',
      plan: {
        title: 'The skateboard champion', continuity: 'A scruffy terrier in a red helmet rides a blue skateboard through a sunny park. Playful cinema with warm afternoon light.', aspectRatio: '16:9',
        shots: [
          { title: 'A bold beginning', prompt: 'The dog plants one paw on the board, then proudly hops aboard as it rolls backward. Wide shot, squeaking wheels.', durationSeconds: 10 },
          { title: 'An accidental trick', prompt: 'The board glides around a cone. The dog flails its paws, then regains its balance as though it meant to do that.', durationSeconds: 10 },
          { title: 'Treats for the champion', prompt: 'The dog coasts to a stop beside a treat stand and raises a triumphant paw. A biscuit lands on the helmet.', durationSeconds: 10 },
        ],
      },
    })
    await page.reload()
    await status().waitFor({ state: 'visible', timeout: 30_000 })
    expect(await page.getByRole('button', { name: 'Open goals', exact: true }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: 'Goal mode', exact: true }).count()).toBe(0)
    await expect.poll(() => tiles().textContent(), { timeout: 15_000 }).toContain('The skateboard champion')
    expect(await tiles().locator('.goal-tile-chip').textContent()).toBe('Review')
    expect(await status().textContent()).toContain('Ready for review')
    expect((await page.locator('.command-line-shell').boundingBox())!.height).toBeLessThanOrEqual(60)
    expect((await call<Array<{ type: string }>>('list_jobs')).some(job => job.type === 'generate_seedance25_video')).toBe(false)
    await status().click()
    await panel().waitFor({ state: 'visible', timeout: 15_000 })
    if (process.env.VIDEOBOOK_GOAL_SCREENSHOTS) await page.screenshot({ path: join(process.env.VIDEOBOOK_GOAL_SCREENSHOTS, 'goal-review.png') })
    expect(await panel().getByLabel('Video title', { exact: true }).inputValue()).toBe('The skateboard champion')
    expect(await panel().locator('.goal-editor-shot').count()).toBe(3)
    await panel().getByLabel('Shot 1 prompt', { exact: true }).fill('The terrier salutes, hops aboard and rolls backward with an astonished expression. Wide shot, a comic squeak.')
    await panel().getByLabel('Shot 1 seconds', { exact: true }).fill('12')
    expect(await panel().getByRole('button', { name: 'Run goal', exact: true }).count()).toBe(0)
    await panel().getByRole('button', { name: 'Save plan', exact: true }).click()
    await expect.poll(() => panel().getByRole('button', { name: 'Run goal', exact: true }).isEnabled()).toBe(true)
    const updated = (await goals()).goals.find(goal => goal.goalId === saved.goalId)!
    expect(updated.plan?.shots[0]?.durationSeconds).toBe(12)
    expect(updated.estimate.usd).toBeGreaterThan(saved.estimate.usd!)
    const notebook = await call<{ cells: Array<{ id: string; type: string; inputs?: { revision?: number } }> }>('get_notebook')
    expect(notebook.cells.find(cell => cell.id === saved.cellId)).toMatchObject({ type: 'goal', inputs: { revision: 2 } })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await status().isVisible()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    if (process.env.VIDEOBOOK_GOAL_SCREENSHOTS) await page.screenshot({ path: join(process.env.VIDEOBOOK_GOAL_SCREENSHOTS, 'goal-phone.png') })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload()
    await status().waitFor({ state: 'visible', timeout: 30_000 })
    await tiles().click()
    await panel().waitFor({ state: 'visible', timeout: 15_000 })
    expect(await panel().getByLabel('Shot 1 seconds', { exact: true }).inputValue()).toBe('12')
    await panel().getByRole('button', { name: 'Run goal', exact: true }).click()
    await expect.poll(async () => (await goals()).goals.find(goal => goal.goalId === saved.goalId)?.status, { timeout: 30_000 }).toBe('failed')
    await expect.poll(() => status().textContent(), { timeout: 15_000 }).toContain('Shot 1 failed')
    await expect.poll(() => page.locator('.goal-status').getAttribute('data-wake'), { timeout: 15_000 }).toBeNull()
    expect(await status().textContent()).toBe('GoalShot 1 failedFailedRetry')
    await expect.poll(() => tiles().locator('.goal-tile-chip').textContent(), { timeout: 15_000 }).toBe('Failed')
    expect(await tiles().locator('.goal-tile-note').textContent()).toBe('Shot 1 failed · open to retry')
    const failed = (await goals()).goals.find(goal => goal.goalId === saved.goalId)!
    expect(failed.error).toContain('placeholder')
    expect(failed.steps.map(step => step.status)).toEqual(['failed', 'skipped', 'skipped', 'skipped'])
    expect((await call<Array<{ type: string }>>('list_jobs')).filter(job => job.type === 'generate_seedance25_video')).toHaveLength(1)
    await status().click()
    await panel().waitFor({ state: 'visible', timeout: 15_000 })
    expect(await panel().getByRole('button', { name: 'Retry shot 1', exact: true }).isVisible()).toBe(true)
    if (process.env.VIDEOBOOK_GOAL_SCREENSHOTS) await page.screenshot({ path: join(process.env.VIDEOBOOK_GOAL_SCREENSHOTS, 'goal-failed.png') })
    expect(errors).toEqual([])
  }, 90_000)

  it('starts a goal from the chat input and shows its planning failure on the tile and in the chat input', async () => {
    const brief = 'make a funny video of a dog on a skateboard, multiple 10s clips'
    const before = await tiles().count()
    await command(`/goal ${brief}`)
    await expect.poll(async () => (await goals()).goals.find(goal => goal.brief === brief)?.status, { timeout: 15_000 }).toBe('failed')
    expect((await goals()).goals[0]?.brief).toBe(brief)
    await expect.poll(() => tiles().count(), { timeout: 15_000 }).toBe(before + 1)
    await expect.poll(() => status().textContent(), { timeout: 15_000 }).toContain('Planning failed')
    expect(await page.getByRole('dialog', { name: 'Goal mode', exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
  }, 30_000)
})
