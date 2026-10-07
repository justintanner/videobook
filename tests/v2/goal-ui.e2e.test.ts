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
  const dialog = () => page.getByRole('dialog', { name: 'Goal mode', exact: true })
  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await dialog().waitFor({ state: 'visible', timeout: 30_000 })
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
    if (await dialog().isVisible()) await dialog().getByRole('button', { name: 'Close goal mode', exact: true }).click()
    await page.setViewportSize({ width: 1440, height: 1000 })
  })

  it('edits and persists a shot plan, supports phone layout, and stops after a real provider configuration failure', async () => {
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
    await command('/goal')
    if (process.env.VIDEOBOOK_GOAL_SCREENSHOTS) await page.screenshot({ path: join(process.env.VIDEOBOOK_GOAL_SCREENSHOTS, 'goal-review.png') })
    expect(await dialog().getByLabel('Video title', { exact: true }).inputValue()).toBe('The skateboard champion')
    expect(await dialog().locator('.goal-shot').count()).toBe(3)
    expect((await call<Array<{ type: string }>>('list_jobs')).some(job => job.type === 'generate_seedance25_video')).toBe(false)
    await dialog().getByLabel('Shot 1 prompt', { exact: true }).fill('The terrier salutes, hops aboard and rolls backward with an astonished expression. Wide shot, a comic squeak.')
    await dialog().getByLabel('Shot 1 seconds', { exact: true }).fill('12')
    expect(await dialog().getByRole('button', { name: 'Run goal', exact: true }).count()).toBe(0)
    await dialog().getByRole('button', { name: 'Save plan', exact: true }).click()
    await expect.poll(() => dialog().getByRole('button', { name: 'Run goal', exact: true }).isEnabled()).toBe(true)
    const updated = (await goals()).goals.find(goal => goal.goalId === saved.goalId)!
    expect(updated.plan?.shots[0]?.durationSeconds).toBe(12)
    expect(updated.estimate.usd).toBeGreaterThan(saved.estimate.usd!)
    if (process.env.VIDEOBOOK_GOAL_SCREENSHOTS) await page.screenshot({ path: join(process.env.VIDEOBOOK_GOAL_SCREENSHOTS, 'goal-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await dialog().getByRole('button', { name: 'Close goal mode', exact: true }).isVisible()).toBe(true)
    expect(await dialog().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await dialog().getByRole('button', { name: 'Run goal', exact: true }).scrollIntoViewIfNeeded()
    if (process.env.VIDEOBOOK_GOAL_SCREENSHOTS) await page.screenshot({ path: join(process.env.VIDEOBOOK_GOAL_SCREENSHOTS, 'goal-phone.png') })
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog().count()).toBe(0)
    await page.reload()
    await expect.poll(() => page.getByRole('button', { name: 'Open goals', exact: true }).isEnabled(), { timeout: 30_000 }).toBe(true)
    await page.getByRole('button', { name: 'Open goals', exact: true }).click()
    await dialog().waitFor({ state: 'visible', timeout: 30_000 })
    expect(await dialog().getByLabel('Shot 1 seconds', { exact: true }).inputValue()).toBe('12')
    await dialog().getByRole('button', { name: 'Run goal', exact: true }).click()
    await expect.poll(async () => (await goals()).goals.find(goal => goal.goalId === saved.goalId)?.status, { timeout: 30_000 }).toBe('failed')
    await expect.poll(() => dialog().locator('.goal-status').textContent(), { timeout: 15_000 }).toBe('Needs attention')
    const failed = (await goals()).goals.find(goal => goal.goalId === saved.goalId)!
    expect(failed.error).toContain('placeholder')
    expect(failed.steps.map(step => step.status)).toEqual(['failed', 'skipped', 'skipped', 'skipped'])
    expect((await call<Array<{ type: string }>>('list_jobs')).filter(job => job.type === 'generate_seedance25_video')).toHaveLength(1)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 1000 })
    expect(errors).toEqual([])
  }, 60_000)

  it('routes the full /goal brief to queued planning and keeps planning failures recoverable', async () => {
    await command('/goal make a funny video of a dog on a skateboard, multiple 10s clips')
    await expect.poll(async () => (await goals()).goals[0]?.status, { timeout: 15_000 }).toBe('failed')
    await expect.poll(() => dialog().locator('.goal-status').textContent(), { timeout: 15_000 }).toBe('Needs attention')
    expect((await goals()).goals[0]?.brief).toBe('make a funny video of a dog on a skateboard, multiple 10s clips')
    expect(await dialog().getByRole('button', { name: 'Plan video', exact: true }).isVisible()).toBe(true)
    expect(errors).toEqual([])
  }, 30_000)
})
