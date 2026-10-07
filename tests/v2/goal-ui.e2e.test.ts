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
import { goalTestPlan, goalTestVideo, seedGoalStage } from '../../server/src/test-goals.js'
import { getChainRun } from '../../server/src/chain-executor.js'
import type { GoalSnapshot } from '../../server/src/tools/goal.js'
import { availablePort, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

const live = process.env.VIDEOBOOK_RUN_MODEL_E2E === '1'
const scenario = live ? it.skip : it

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
    if (live) {
      if (!process.env.OPENAI_API_KEY || !process.env.KIE_API_KEY) throw new Error('Live goal verification requires OPENAI_API_KEY and KIE_API_KEY')
    } else {
      process.env.OPENAI_API_KEY = 'test-goal-browser'
      process.env.KIE_API_KEY = 'test-goal-browser'
    }
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
      const character = column === 0
        ? '<ellipse cx="128" cy="147" rx="57" ry="69" fill="#ed8a32"/><circle cx="128" cy="85" r="48" fill="#ed8a32"/><path d="M172 82 l32 16 -32 14" fill="#e5bf39"/><circle cx="139" cy="77" r="5"/><path d="M85 117 h85 v19 h-85z M133 135 l24 43 h-23 l-12-43" fill="#c84235"/><path d="M98 210 v21 m48-21 v21" stroke="#574228" stroke-width="8"/>'
        : '<rect x="75" y="105" width="108" height="110" rx="12" fill="#357fbb"/><rect x="69" y="42" width="120" height="87" rx="9" fill="#58a1cb"/><circle cx="103" cy="79" r="9"/><circle cx="155" cy="79" r="9"/><path d="M101 105 h53" stroke="#d8efff" stroke-width="8"/><path d="M71 128 h118 v17 h-118z M145 144 l17 40 h-25 l-8-40" fill="#e6c13c"/><path d="M99 211 v22 m58-22 v22" stroke="#38556e" stroke-width="12"/>'
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#f5ead9"/>${character}</svg>`
      const bytes = live ? await sharp(Buffer.from(svg)).png().toBuffer()
        : await sharp({ create: { width: 96, height: 128, channels: 3, background } }).png().toBuffer()
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
    if (live) console.info(JSON.stringify({ preservedGoalBook: bookId, root, notebookId }))
    else await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
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

  scenario('reviews and saves before approving only the frame, shows stable queued progress, and stops', async () => {
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

  scenario('shows placeholder failure and retries only the frame with new tiles and provenance', async () => {
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
    await expect.poll(() => engine.jobs.queue.list({ type: 'generate_gpt_image_2_5' }).length, { timeout: 15_000 }).toBe(before + 2)
    await expect.poll(async () => (await current(saved)).status, { timeout: 30_000 }).toBe('failed')
    await status().click()
    await expect.poll(() => panel().getByRole('button', { name: 'Retry frame', exact: true }).isVisible(), { timeout: 15_000 }).toBe(true)
    await screenshot('goal-failed')
    expect(engine.jobs.queue.list({ type: 'generate_seedance25_video' })).toHaveLength(0)
    expect(errors).toEqual([])
  }, 60_000)

  scenario('opens frame and storyboard reviews with thumbnails and individual regeneration', async () => {
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

  scenario('combines a finished goal into one local video and opens its preview', async () => {
    const saved = await create()
    await seedGoalStage(engine, saved.goalId, 'frame')
    await current(saved)
    await seedGoalStage(engine, saved.goalId, 'storyboards')
    await current(saved)
    const videoIds = await Promise.all(['red', 'blue'].map(color => goalTestVideo(engine, root, color)))
    await seedGoalStage(engine, saved.goalId, 'videos', { videoIds })
    const complete = await call<GoalSnapshot>('video_goal', { action: 'assemble', goal_id: saved.goalId })
    await open(complete)
    await panel().getByRole('button', { name: 'Combine into one video', exact: true }).click()
    await expect.poll(async () => (await current(saved)).combined?.status, { timeout: 30_000 }).toBe('completed')
    await expect.poll(() => panel().getByRole('button', { name: 'Open combined video', exact: true }).isVisible(), { timeout: 15_000 }).toBe(true)
    const combined = (await current(saved)).combined!
    await expect.poll(() => page.locator(`.react-flow__node[data-id="${combined.cellId}"] .cell-goal-mark`).textContent(), { timeout: 15_000 }).toContain('Combined')
    await panel().getByRole('button', { name: 'Open combined video', exact: true }).click()
    await page.getByRole('dialog', { name: /Fullscreen preview for/ }).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  }, 60_000)

  scenario('opts into ending frames, reviews both images and regenerates one storyboard pair', async () => {
    const saved = await create()
    await open(saved)
    expect(await panel().getByLabel('Ending storyboards', { exact: true }).inputValue()).toBe('off')
    await panel().getByLabel('Ending storyboards', { exact: true }).selectOption('on')
    await panel().getByLabel('Shot 2 ending storyboard prompt', { exact: true }).fill('Both characters wave beside the stationary skateboard.')
    await panel().getByRole('button', { name: 'Save plan', exact: true }).click()
    await expect.poll(async () => (await current(saved)).revision).toBe(2)
    const enabled = await current(saved)
    expect(enabled.plan).toMatchObject({ frameContinuity: true })
    expect(enabled.estimate.storyboards.usd).toBeCloseTo(saved.estimate.storyboards.usd! * 2)
    await seedGoalStage(engine, saved.goalId, 'frame')
    await current(saved)
    await seedGoalStage(engine, saved.goalId, 'storyboards')
    const ready = await current(saved)
    expect(ready.stages.storyboards!.outputs).toHaveLength(4)
    await open(ready)
    expect(await panel().getByRole('button', { name: /Open Ending storyboard/ }).count()).toBe(2)
    expect(await panel().getByLabel('Ending storyboards', { exact: true }).isDisabled()).toBe(true)
    await panel().getByRole('button', { name: /Open Ending storyboard 1/ }).scrollIntoViewIfNeeded()
    await screenshot('goal-ending-storyboards')
    await pauseBookQueueForTests(bookId)
    await panel().getByRole('button', { name: /Regenerate storyboard pair 2/ }).click()
    await expect.poll(async () => (await current(saved)).status).toBe('running')
    const regenerating = await current(saved)
    expect(getChainRun(engine, regenerating.chainId!)!.steps.map(step => step.id)).toEqual(['storyboard2', 'storyboard4'])
    expect(errors).toEqual([])
  }, 60_000)

  scenario('requires character mentions and reveals a goal created from the chat input', async () => {
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

  it.runIf(live)('plans and generates a complete two-shot goal with real providers', async () => {
    const brief = '@a1 @a2 make two 4s funny clips of the orange bird in a red scarf teaching the blue robot in a yellow scarf to skateboard in a sunny park. Simple friendly cartoon. 1K images and 480p video, landscape.'
    await command(`/goal ${brief}`)
    const waitForGoal = async (stage: string, wanted: string, timeout = 600_000): Promise<GoalSnapshot> => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const latest = (await goals()).goals.find(goal => goal.brief === brief)
        if (latest?.status === 'failed' || latest?.status === 'interrupted') throw new Error(latest.error ?? 'Goal failed')
        if (latest?.status === wanted && (stage === '*' || latest.stage === stage)) return latest
        await new Promise(resolve => setTimeout(resolve, 2_000))
      }
      throw new Error(`Goal did not reach ${stage}:${wanted}`)
    }
    const planned = await waitForGoal('frame', 'review', 120_000)
    const plan = { ...planned.plan, version: 2, imageResolution: '1K', videoResolution: '480p', shots: planned.plan!.shots.map(shot => ({ ...shot, durationSeconds: 4 })) }
    const reviewed = await call<GoalSnapshot>('video_goal', { action: 'update', goal_id: planned.goalId, revision: planned.revision, plan })
    expect(reviewed.plan?.shots).toHaveLength(2)
    expect(reviewed.estimate.total.usd).not.toBeNull()
    expect(reviewed.estimate.total.usd!).toBeLessThan(3)
    console.info(JSON.stringify({ goalId: reviewed.goalId, bookId, root, estimate: reviewed.estimate }))
    await open(reviewed)
    await panel().getByRole('button', { name: 'Generate full frame', exact: true }).click()
    const frame = await waitForGoal('storyboards', 'review')
    expect(frame.stages.frame!.outputs).toHaveLength(1)
    await status().click()
    await panel().getByRole('button', { name: /Approve frame/ }).waitFor({ state: 'visible', timeout: 30_000 })
    await screenshot('live-full-frame')
    await panel().getByRole('button', { name: /Approve frame/ }).click()
    const boards = await waitForGoal('videos', 'review')
    expect(boards.stages.storyboards!.outputs).toHaveLength(2)
    await status().click()
    await panel().getByRole('button', { name: /Approve storyboards/ }).waitFor({ state: 'visible', timeout: 30_000 })
    await screenshot('live-storyboards')
    await panel().getByRole('button', { name: /Approve storyboards/ }).click()
    const completed = await waitForGoal('*', 'completed', 900_000)
    expect(completed.stages.videos!.outputs).toHaveLength(2)
    expect(completed.assembly!.durationFrames).toBeGreaterThan(0)
    const sequence = engine.sequences.getPrimary()
    expect(sequence.clips.filter(clip => completed.clipIds.includes(clip.clipId))).toHaveLength(2)
    const document = engine.notebooks.read(notebookId)
    if (!document.ok) throw new Error(document.error.message)
    for (const [stage, count] of [['frame', 1], ['storyboards', 2], ['videos', 2]] as const) {
      const outputs = completed.stages[stage]!.outputs
      expect(outputs).toHaveLength(count)
      for (const output of outputs) {
        expect(document.value.cells.some(cell => cell.id === output.cellId && cell.outputArtifactId === output.artifactId)).toBe(true)
        expect(document.value.edges.filter(edge => edge.target === output.producerCellId)).toHaveLength(stage === 'frame' ? 2 : stage === 'storyboards' ? 3 : 1)
      }
    }
    const usage = await call('get_book_usage')
    console.info(JSON.stringify({ goalId: reviewed.goalId, bookId, root, usage, completed: completed.assembly }))
    await status().click()
    await screenshot('live-complete')
    expect(errors).toEqual([])
  }, 1_800_000)

})
