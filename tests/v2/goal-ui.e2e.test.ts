import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import express from 'express'
import sharp from 'sharp'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import type { Engine } from 'videobook-engine'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine } from '../../server/src/book-context.js'
import { createHttpHandler } from '../../server/src/server.js'
import { pauseBookQueueForTests, queue, setEngineRoot, stopBookQueue } from '../../server/src/queue.js'
import { registerAllJobHandlers } from '../../server/src/jobs/index.js'
import { goalTestPlan, seedGoalStage } from '../../server/src/test-goals.js'
import { getChainRun } from '../../server/src/chain-executor.js'
import type { GoalSnapshot } from '../../server/src/tools/goal.js'
import { availablePort, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

describe('staged goal mode in the browser', () => {
  let root = ''
  let server: Server | undefined
  let books: BookManager
  let engine: Engine
  let vite: StartedProcess | undefined
  let browser: Browser
  let page: Page
  let client: Client
  let bookId = ''
  let notebookId = ''
  let appUrl = ''
  const errors: string[] = []
  const previousKeys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, KIE_API_KEY: process.env.KIE_API_KEY }
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(await client.callTool({ name, arguments: { book_id: bookId, notebook_id: notebookId, ...args } })) as T
  const goals = () => call<{ goals: GoalSnapshot[] }>('video_goal', { action: 'list' })
  const current = (goal: GoalSnapshot) => call<GoalSnapshot>('video_goal', { action: 'status', goal_id: goal.goalId })
  const status = () => page.locator('.goal-status-button')
  const panel = () => page.locator('.goal-panel')
  const tile = (goal: GoalSnapshot) => page.locator(`.react-flow__node[data-id="${goal.cellId}"]`)
  const create = () => call<GoalSnapshot>('video_goal', { action: 'create', brief: '@a1@a2 on a skateboard, two 10s clips', plan: goalTestPlan(2) })
  const open = async (goal: GoalSnapshot) => {
    await page.reload()
    await tile(goal).waitFor({ state: 'visible', timeout: 30_000 })
    await tile(goal).click()
    await panel().waitFor({ state: 'visible', timeout: 15_000 })
  }
  const screenshot = async (name: string) => {
    if (process.env.VIDEOBOOK_GOAL_SCREENSHOTS) await page.screenshot({ path: join(process.env.VIDEOBOOK_GOAL_SCREENSHOTS, `${name}.png`) })
  }
  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
  }

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = 'test-goal-browser'
    process.env.KIE_API_KEY = 'test-goal-browser'
    root = await mkdtemp(join(tmpdir(), 'videobook-goal-ui-'))
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    books = new BookManager({ libraryDir: join(root, 'books') })
    await books.ready()
    const handler = toNodeHandler(createHttpHandler(scopedBookEngine, books))
    const app = express()
    app.use(express.json({ limit: '2mb' }))
    app.all('/mcp', (request, response) => { void handler(request, response, request.body) })
    app.get(/^\/files\/([^/]+)\/([^/]+)\/(.+)$/, async (request, response) => {
      const book = books.get(String(request.params[0]))
      if (!book.ok) { response.sendStatus(404); return }
      const file = await book.value.engine.files.read(String(request.params[1]), String(request.params[2]))
      if (!file.ok) { response.sendStatus(404); return }
      response.type(String(request.params[2])).send(file.value)
    })
    server = createServer(app)
    await new Promise<void>(resolve => server!.listen(port, '127.0.0.1', resolve))
    client = new Client({ name: 'goal-ui-e2e', version: '2' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    bookId = (await call<{ bookId: string }>('create_book', { name: 'goal-ui' })).bookId
    notebookId = (await call<Array<{ id: string }>>('list_notebooks'))[0]!.id
    const book = books.get(bookId)
    if (!book.ok) throw new Error(book.error.message)
    engine = book.value.engine
    registerAllJobHandlers(engine)
    await setEngineRoot(book.value.rootDir, engine)
    for (const [column, background] of ['#cf593b', '#2878b4'].entries()) {
      const bytes = await sharp({ create: { width: 96, height: 128, channels: 3, background } }).png().toBuffer()
      const asset = await call<{ assetId: string }>('upload_file', { filename: `character-${column + 1}.png`, data: bytes.toString('base64') })
      await call('create_notebook_cell', { cell: { type: 'image', slot: { row: 0, column }, output_artifact_id: asset.assetId } })
    }
    const vitePort = await availablePort()
    appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      ...process.env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
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
    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server!.close(() => resolve()))
    }
    await queue.stop()
    await books?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    for (const [key, value] of Object.entries(previousKeys)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }, 30_000)

  afterEach(async context => {
    if (context.task.result?.state === 'fail') {
      await screenshot('goal-failure')
      console.error(await panel().textContent())
    }
    await page?.setViewportSize({ width: 1440, height: 1000 })
    for (const goal of (await goals()).goals) {
      if (['running', 'planning', 'review'].includes(goal.status)) await call('video_goal', { action: 'cancel', goal_id: goal.goalId })
    }
    await stopBookQueue(bookId)
    await queue.startBook(bookId)
  })

  it('reviews and saves before approving only the frame, shows stable queued progress, and stops', async () => {
    const saved = await create()
    await open(saved)
    expect(await panel().getByLabel('Video title', { exact: true }).inputValue()).toBe(saved.plan!.title)
    expect(await panel().locator('.goal-editor-shot').count()).toBe(2)
    expect(await panel().getByLabel('Character images').locator('img').count()).toBe(2)
    expect(await page.getByRole('button', { name: 'Open goals', exact: true }).count()).toBe(0)
    expect(await status().textContent()).toContain('Review plan')
    await panel().getByLabel('Full frame prompt', { exact: true }).fill('Both characters salute beside the skateboard, wide park view.')
    await panel().getByLabel('Shot 1 seconds', { exact: true }).fill('12')
    await screenshot('goal-plan')
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    expect((await status().boundingBox())!.height).toBe(32)
    expect(await status().locator('.goal-status-short').isVisible()).toBe(true)
    await screenshot('goal-phone')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await pauseBookQueueForTests(bookId)
    await panel().getByRole('button', { name: 'Generate full frame', exact: true }).click()
    await expect.poll(async () => (await current(saved)).status).toBe('running')
    await expect.poll(() => status().textContent(), { timeout: 15_000 }).toContain('Full frame · Generating')
    await page.getByLabel('Clear selection', { exact: true }).click()
    await expect.poll(() => page.locator('.composer-history-entry[data-role="status"]').allTextContents(), { timeout: 15_000 }).toContainEqual(expect.stringContaining('Plan approved'))
    const running = await current(saved)
    expect(running.revision).toBe(2)
    expect(running.plan?.shots[0]?.durationSeconds).toBe(12)
    expect(engine.jobs.queue.list({ type: 'generate_gpt_image_2_5' })).toHaveLength(1)
    expect(engine.jobs.queue.list({ type: 'generate_seedance25_video' })).toHaveLength(0)
    await expect.poll(() => page.locator('.cell-goal-mark').count(), { timeout: 15_000 }).toBe(2)
    expect(getChainRun(engine, running.chainId!)!.steps.map(step => step.id)).toEqual(['frame'])
    await status().click()
    await panel().getByRole('button', { name: 'Stop goal', exact: true }).click()
    await expect.poll(async () => (await current(saved)).status).toBe('cancelled')
    expect(errors).toEqual([])
  }, 60_000)

  it('shows placeholder failure and retries only the frame with new tiles and provenance', async () => {
    const saved = await create()
    await open(saved)
    const before = engine.jobs.queue.list({ type: 'generate_gpt_image_2_5' }).length
    await panel().getByRole('button', { name: 'Generate full frame', exact: true }).click()
    await expect.poll(async () => (await current(saved)).status, { timeout: 30_000 }).toBe('failed')
    await expect.poll(() => status().textContent(), { timeout: 15_000 }).toContain('Full frame failed')
    const failed = await current(saved)
    expect(failed.error).toContain('placeholder')
    await status().click()
    await panel().getByRole('button', { name: 'Retry frame', exact: true }).click()
    await expect.poll(() => engine.jobs.queue.list({ type: 'generate_gpt_image_2_5' }).length).toBe(before + 2)
    await expect.poll(async () => (await current(saved)).status, { timeout: 30_000 }).toBe('failed')
    await status().click()
    await expect.poll(() => panel().getByRole('button', { name: 'Retry frame', exact: true }).isVisible(), { timeout: 15_000 }).toBe(true)
    await screenshot('goal-failed')
    expect(engine.jobs.queue.list({ type: 'generate_seedance25_video' })).toHaveLength(0)
    expect(errors).toEqual([])
  }, 60_000)

  it('opens frame and storyboard reviews with thumbnails and individual regeneration', async () => {
    const saved = await create()
    await seedGoalStage(engine, saved.goalId, 'frame')
    const frame = await current(saved)
    expect(frame.stage).toBe('storyboards')
    await open(frame)
    expect(await panel().getByRole('button', { name: 'Open Full frame', exact: true }).isVisible()).toBe(true)
    expect(await panel().getByRole('button', { name: /Approve frame/ }).isVisible()).toBe(true)
    await screenshot('goal-frame')
    await seedGoalStage(engine, saved.goalId, 'storyboards')
    const boards = await current(saved)
    expect(boards.stage).toBe('videos')
    await open(boards)
    expect(await panel().getByRole('button', { name: /Regenerate storyboard/ }).count()).toBe(2)
    expect(await panel().getByRole('button', { name: /Approve storyboards/ }).isVisible()).toBe(true)
    await screenshot('goal-storyboards')
    await pauseBookQueueForTests(bookId)
    await panel().getByRole('button', { name: /Regenerate storyboard 2/ }).click()
    await expect.poll(async () => (await current(saved)).status).toBe('running')
    const regenerating = await current(saved)
    expect(getChainRun(engine, regenerating.chainId!)!.steps.map(step => step.id)).toEqual(['storyboard2'])
    expect(regenerating.stages.storyboards!.outputs).toEqual(boards.stages.storyboards!.outputs)
  }, 60_000)

  it('requires character mentions and reveals a goal created from the chat input', async () => {
    const before = (await goals()).goals.length
    await command('/goal a funny skateboard video')
    await expect.poll(() => page.locator('.chat-bubble-assistant').last().textContent(), { timeout: 15_000 }).toContain('Mention the character images')
    expect((await goals()).goals).toHaveLength(before)
    const brief = '@a1@a2 make two 4s funny skateboard clips'
    await command(`/goal ${brief}`)
    await expect.poll(async () => (await goals()).goals.find(goal => goal.brief === brief)?.status, { timeout: 15_000 }).toBe('failed')
    await expect.poll(() => status().textContent(), { timeout: 15_000 }).toContain('Planning failed')
    expect(await page.getByRole('dialog', { name: 'Goal mode', exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
  }, 30_000)
})
