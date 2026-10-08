import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { findPrimaryMediaFile } from 'videobook-engine'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine } from '../../server/src/book-context.js'
import { createHttpHandler } from '../../server/src/server.js'
import { pauseBookQueueForTests, queue, setEngineRoot, stopBookQueue } from '../../server/src/queue.js'
import { registerAllJobHandlers } from '../../server/src/jobs/index.js'
import { goalTestPlan, goalTestVideo, seedGoalStage } from '../../server/src/test-goals.js'
import { compileReviseStillStep, compileStoryboardSteps, compileVideoSteps, goalBriefConstraints, goalPlanSchema, goalPromptBudgetIssues } from '../../server/src/goal-plan.js'
import { goalPromptWords } from '../../server/src/goal-prompt-budget.js'
import { probeVideo } from '../../server/src/ffmpeg.js'
import { readGoal, requireGoalContent, saveGoal, writeGoalContent } from '../../server/src/goal-store.js'
import { estimateGoal } from '../../server/src/jobs/plan-goal.js'
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
    expect(await tile(saved).locator('[title="Aspect ratio"]').textContent()).toBe('9:16')
    expect(await panel().getByRole('radio', { name: 'Portrait · 9:16', exact: true }).getAttribute('aria-checked')).toBe('true')
    expect(await panel().getByLabel('Shot 1 storyboard prompt', { exact: true }).getAttribute('rows')).toBe('2')
    expect(await panel().locator('.goal-prompt-input').first().textContent()).toContain('/ 40 words')
    await panel().getByText('Advanced', { exact: true }).click()
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
    await panel().getByRole('button', { name: /^Generate frame ·/ }).click()
    await expect.poll(async () => (await current(saved)).status).toBe('running')
    await expect.poll(() => status().textContent(), { timeout: 15_000 }).toContain('Full frame · Generating')
    await page.getByLabel('Clear selection', { exact: true }).click()
    await expect.poll(() => page.locator('.composer-history-entry[data-role="status"]').allTextContents(), { timeout: 15_000 }).toContainEqual(expect.stringContaining('Plan approved'))
    const running = await current(saved)
    expect(running.revision).toBe(2)
    expect(running.plan?.shots[0]?.durationSeconds).toBe(12)
    const jobs = engine.jobs.queue.list({ type: 'generate_gpt_image_2_5' })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.payload).toMatchObject({ input: { aspect_ratio: '9:16', resolution: '2K' } })
    expect(engine.jobs.queue.list({ type: 'generate_seedance25_video' })).toHaveLength(0)
    await expect.poll(() => page.locator('.cell-goal-mark').count(), { timeout: 15_000 }).toBe(2)
    expect(getChainRun(engine, running.chainId!)!.steps.map(step => step.id)).toEqual(['frame'])
    await status().click()
    await panel().getByRole('button', { name: 'Stop goal', exact: true }).click()
    await expect.poll(async () => (await current(saved)).status).toBe('cancelled')
    expect(errors).toEqual([])
  }, 60_000)

  scenario('shows portrait defaults for a goal created without a supplied plan or format words', async () => {
    await pauseBookQueueForTests(bookId)
    const created = await call<GoalSnapshot>('video_goal', { action: 'create', brief: '@a1 @a2 as Mr Bean in Thailand' })
    expect(created.plan).toBeNull()
    const stored = readGoal(engine, created.goalId)
    const content = requireGoalContent(engine, stored)
    const constraints = goalBriefConstraints(content.brief)
    const plan = { ...goalTestPlan(constraints.shotCount), aspectRatio: constraints.aspectRatio }
    await writeGoalContent(engine, stored, { ...content, plan, revision: 1, estimate: await estimateGoal(engine, plan, content.characters) })
    await engine.jobs.queue.abort(stored.planningJobId!, 'Fixture plan completed')
    saveGoal(engine, { ...stored, status: 'review', stage: 'frame' })
    await open(await current(created))
    expect(await tile(created).locator('[title="Aspect ratio"]').textContent()).toBe('9:16')
    expect(await panel().getByRole('radio', { name: 'Portrait · 9:16', exact: true }).getAttribute('aria-checked')).toBe('true')
    expect(await panel().locator('.goal-editor-shot').count()).toBe(3)
    await page.setViewportSize({ width: 1440, height: 900 })
    const layout = await page.locator('.goal-panel-body').evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight, sections: [...element.querySelectorAll('.goal-editor > *')].map(child => ({ name: child.className, height: child.getBoundingClientRect().height, display: getComputedStyle(child).display })) }))
    expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.height + 1)
    await screenshot('goal-plan-compact')
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    expect(await page.locator('.goal-panel-body').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await screenshot('goal-plan-compact-phone')
  }, 30_000)

  scenario('picks a frame version, revises it with feedback, and stops the new image request', async () => {
    const created = await create()
    await seedGoalStage(engine, created.goalId, 'frame')
    const first = await current(created)
    await seedGoalStage(engine, created.goalId, 'frame')
    const second = await current(created)
    await open(second)
    const card = panel().getByRole('region', { name: 'Full frame', exact: true })
    await card.getByRole('button', { name: 'Full frame v1', exact: true }).click()
    const firstId = first.stages.frame!.outputs[0]!.artifactId
    await expect.poll(async () => (await current(created)).stages.frame!.outputs[0]!.artifactId).toBe(firstId)
    expect(await card.getByRole('button', { name: 'Full frame v1', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await card.getByLabel('What should change in Full frame?', { exact: true }).fill('Give Character 1 a red cap')
    await screenshot('goal-frame-versions')
    await pauseBookQueueForTests(bookId)
    const before = engine.jobs.queue.list({ type: 'generate_gpt_image_2_5' }).length
    await card.getByRole('button', { name: /^Revise ·/ }).click()
    await expect.poll(() => engine.jobs.queue.list({ type: 'generate_gpt_image_2_5' }).length).toBe(before + 1)
    const running = await current(created)
    const job = engine.jobs.queue.list({ type: 'generate_gpt_image_2_5' }).find(job => String(job.payload.input && (job.payload.input as Record<string, unknown>).prompt).includes('Give Character 1 a red cap'))!
    expect(job.payload).toMatchObject({ sourceImageIds: [firstId, ...created.characters.map(character => character.artifactId)], input: { prompt: expect.stringContaining('Revise @image1: Give Character 1 a red cap') } })
    expect(running.stages.frame!.attempts!.at(-1)).toMatchObject({ parentArtifactId: firstId, feedback: 'Give Character 1 a red cap' })
    await expect.poll(() => status().textContent(), { timeout: 15_000 }).toContain('Revising frame')
    await status().click()
    await panel().getByRole('button', { name: 'Stop goal', exact: true }).click()
    await expect.poll(async () => (await current(created)).status).toBe('cancelled')
    expect(errors).toEqual([])
  }, 60_000)

  scenario('shows placeholder failure and retries only the frame with new tiles and provenance', async () => {
    const saved = await create()
    await open(saved)
    const before = engine.jobs.queue.list({ type: 'generate_gpt_image_2_5' }).length
    await panel().getByRole('button', { name: /^Generate frame ·/ }).click()
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
    expect(await panel().getByRole('button', { name: /Use this frame/ }).isVisible()).toBe(true)
    await screenshot('goal-frame')
    await seedGoalStage(engine, saved.goalId, 'storyboards')
    const boards = await current(saved)
    expect(boards.stage).toBe('videos')
    await open(boards)
    expect(await panel().getByRole('button', { name: 'Regenerate', exact: true }).count()).toBe(2)
    expect(await panel().getByRole('button', { name: /Use these storyboards/ }).isVisible()).toBe(true)
    await screenshot('goal-storyboards')
    await pauseBookQueueForTests(bookId)
    await panel().getByRole('region', { name: 'Storyboard 2', exact: true }).getByRole('button', { name: 'Regenerate', exact: true }).click()
    await expect.poll(async () => (await current(saved)).status).toBe('running')
    const regenerating = await current(saved)
    expect(getChainRun(engine, regenerating.chainId!)!.steps.map(step => step.id)).toEqual(['storyboard2'])
    expect(regenerating.stages.storyboards!.outputs[0]).toEqual(boards.stages.storyboards!.outputs[0])
    expect(regenerating.stages.storyboards!.outputs[1]!.artifactId).toBe(boards.stages.storyboards!.outputs[1]!.artifactId)
    expect(regenerating.stages.storyboards!.outputs[1]!.versions).toHaveLength(2)
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

  scenario('opts into ending frames, reviews both images and regenerates an ending independently', async () => {
    const saved = await create()
    await open(saved)
    await panel().getByText('Advanced', { exact: true }).click()
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
    await panel().getByText('Advanced', { exact: true }).click()
    expect(await panel().getByLabel('Ending storyboards', { exact: true }).isDisabled()).toBe(true)
    await panel().getByRole('button', { name: /Open Ending storyboard 1/ }).scrollIntoViewIfNeeded()
    await screenshot('goal-ending-storyboards')
    await pauseBookQueueForTests(bookId)
    await panel().getByRole('region', { name: 'Ending storyboard 2', exact: true }).getByRole('button', { name: 'Regenerate', exact: true }).click()
    await expect.poll(async () => (await current(saved)).status).toBe('running')
    const regenerating = await current(saved)
    expect(getChainRun(engine, regenerating.chainId!)!.steps.map(step => step.id)).toEqual(['storyboard4'])
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
    const brief = '@a1 @a2 make two 4s funny clips of the orange bird in a red scarf teaching the blue robot in a yellow scarf to skateboard in a sunny park. Simple friendly cartoon. 1K images and 480p video.'
    const frameFeedback = 'Give Character 1 a red cap'
    const storyboardFeedback = 'Move Character 2 closer'
    const requests: Array<{ artifactId: string; stage: string; prompt: string; words: number; aspectRatio: string; path: string; width: number; height: number; duration?: number; hasAudio?: boolean }> = []
    const reportPath = process.env.VIDEOBOOK_GOAL_REPORT ?? join(root, 'live-report.json')
    const checkpoint = async (goal: GoalSnapshot) => writeFile(reportPath, JSON.stringify({ bookId, notebookId, root, goal, requests, usage: await call('get_book_usage') }, null, 2))
    const mediaPath = async (artifactId: string, kind: 'image' | 'video') => {
      const manifest = await engine.files.manifest(artifactId)
      if (!manifest.ok) throw new Error(manifest.error.message)
      const file = findPrimaryMediaFile(manifest.value.files, kind)
      if (!file) throw new Error(`No ${kind} file for ${artifactId}`)
      return join(manifest.value.path, file.name)
    }
    const inspect = async (goal: GoalSnapshot, stage: 'frame' | 'storyboards' | 'videos') => {
      const ids = stage === 'videos' ? goal.stages[stage]!.outputs.map(output => output.artifactId)
        : goal.stages[stage]!.attempts!.map(attempt => attempt.artifactId!)
      for (const artifactId of ids.filter(id => !requests.some(request => request.artifactId === id))) {
        const result = await call<{ payload: { input: { prompt: string; aspect_ratio: string } } }>('inspect_generation_request', { asset_id: artifactId })
        const { prompt, aspect_ratio: aspectRatio } = result.payload.input
        const words = goalPromptWords(prompt)
        expect(words, prompt).toBeLessThan(stage === 'frame' ? 145 : stage === 'storyboards' ? 60 : 70)
        expect(aspectRatio).toBe(stage === 'videos' ? 'adaptive' : '9:16')
        const path = await mediaPath(artifactId, stage === 'videos' ? 'video' : 'image')
        const media = stage === 'videos' ? await probeVideo(path) : await sharp(path).metadata()
        expect(media.height).toBeGreaterThan(media.width!)
        requests.push({ artifactId, stage, prompt, words, aspectRatio, path, width: media.width!, height: media.height!,
          ...('hasAudio' in media ? { duration: media.duration, hasAudio: media.hasAudio } : {}) })
      }
      await checkpoint(goal)
    }
    await command(`/goal ${brief}`)
    const waitForGoal = async (stage: string, wanted: string, timeout = 1_800_000, previousChainId?: string | null): Promise<GoalSnapshot> => {
      const deadline = Date.now() + timeout
      let lastProgress = ''
      let lastLoggedAt = 0
      while (Date.now() < deadline) {
        const latest = (await goals()).goals.find(goal => goal.brief === brief)
        const progress = latest ? `${latest.stage}:${latest.status}:${latest.chainId}` : 'creating'
        if (progress !== lastProgress || Date.now() - lastLoggedAt >= 60_000) {
          console.info(JSON.stringify({ goalId: latest?.goalId, progress, steps: latest?.steps.map(step => ({ id: step.id, status: step.status })) }))
          lastProgress = progress
          lastLoggedAt = Date.now()
          if (latest) await checkpoint(latest)
        }
        if (latest?.status === 'failed' || latest?.status === 'interrupted') throw new Error(latest.error ?? 'Goal failed')
        if (latest?.status === wanted && (stage === '*' || latest.stage === stage) && latest.chainId !== previousChainId) return latest
        await new Promise(resolve => setTimeout(resolve, 2_000))
      }
      throw new Error(`Goal did not reach ${stage}:${wanted}`)
    }
    const planned = await waitForGoal('frame', 'review', 120_000)
    const plan = goalPlanSchema.parse(planned.plan)
    expect(plan.aspectRatio).toBe('9:16')
    expect(plan.imageResolution).toBe('1K')
    expect(plan.videoResolution).toBe('480p')
    expect(plan.shots.map(shot => shot.durationSeconds)).toEqual([4, 4])
    expect(goalPromptBudgetIssues(plan)).toEqual([])
    const predictedBoards = [...compileStoryboardSteps(plan, planned.characters, '@a1'), compileReviseStillStep(plan, planned.characters, 'storyboards', 1, '@a1', storyboardFeedback, '@a2')]
    for (const step of predictedBoards) expect(goalPromptWords(String(step.params.prompt)), String(step.params.prompt)).toBeLessThan(60)
    for (const step of compileVideoSteps(planned.goalId, plan, planned.characters, ['@a1', '@a2'])) expect(goalPromptWords(String(step.params.prompt))).toBeLessThan(70)
    const reviewed = await call<GoalSnapshot>('video_goal', { action: 'update', goal_id: planned.goalId, revision: planned.revision, plan })
    expect(reviewed.plan?.shots).toHaveLength(2)
    expect(reviewed.estimate.total.usd).not.toBeNull()
    const mediaEstimate = reviewed.estimate.total.usd! + 2 * reviewed.estimate.still.usd!
    expect(mediaEstimate).toBeLessThan(3)
    console.info(JSON.stringify({ goalId: reviewed.goalId, bookId, root, reportPath, mediaEstimate }))
    await open(reviewed)
    await panel().getByRole('button', { name: /^Generate frame ·/ }).click()
    const frame = await waitForGoal('storyboards', 'review')
    expect(frame.stages.frame!.outputs).toHaveLength(1)
    await inspect(frame, 'frame')
    await status().click()
    await panel().getByRole('button', { name: /Use this frame/ }).waitFor({ state: 'visible', timeout: 30_000 })
    await screenshot('live-full-frame')
    const frameCard = panel().getByRole('region', { name: 'Full frame', exact: true })
    await frameCard.getByLabel('What should change in Full frame?', { exact: true }).fill(frameFeedback)
    await frameCard.getByRole('button', { name: /^Revise ·/ }).click()
    const revisedFrame = await waitForGoal('storyboards', 'review', 1_800_000, frame.chainId)
    expect(revisedFrame.stages.frame!.attempts).toHaveLength(2)
    expect(revisedFrame.stages.frame!.attempts!.at(-1)).toMatchObject({ feedback: frameFeedback, parentArtifactId: frame.stages.frame!.outputs[0]!.artifactId })
    await inspect(revisedFrame, 'frame')
    await status().click()
    await frameCard.getByRole('button', { name: 'Full frame v1', exact: true }).click()
    await expect.poll(async () => (await current(reviewed)).stages.frame!.outputs[0]!.artifactId).toBe(frame.stages.frame!.outputs[0]!.artifactId)
    await frameCard.getByRole('button', { name: 'Full frame v2', exact: true }).click()
    await expect.poll(async () => (await current(reviewed)).stages.frame!.outputs[0]!.artifactId).toBe(revisedFrame.stages.frame!.outputs[0]!.artifactId)
    await screenshot('live-revised-frame')
    await panel().getByRole('button', { name: /Use this frame/ }).click()
    const boards = await waitForGoal('videos', 'review')
    expect(boards.stages.storyboards!.outputs).toHaveLength(2)
    await inspect(boards, 'storyboards')
    await status().click()
    await panel().getByRole('button', { name: /Use these storyboards/ }).waitFor({ state: 'visible', timeout: 30_000 })
    await screenshot('live-storyboards')
    const boardCard = panel().getByRole('region', { name: 'Storyboard 2', exact: true })
    await boardCard.getByLabel('What should change in Storyboard 2?', { exact: true }).fill(storyboardFeedback)
    await boardCard.getByRole('button', { name: /^Revise ·/ }).click()
    const revisedBoards = await waitForGoal('videos', 'review', 1_800_000, boards.chainId)
    expect(revisedBoards.stages.storyboards!.outputs[0]).toEqual(boards.stages.storyboards!.outputs[0])
    expect(revisedBoards.stages.storyboards!.attempts).toHaveLength(3)
    expect(revisedBoards.stages.storyboards!.attempts!.at(-1)).toMatchObject({ feedback: storyboardFeedback, parentArtifactId: boards.stages.storyboards!.outputs[1]!.artifactId, frameArtifactId: revisedFrame.stages.frame!.outputs[0]!.artifactId })
    await inspect(revisedBoards, 'storyboards')
    await status().click()
    await panel().getByRole('button', { name: /Use these storyboards/ }).waitFor({ state: 'visible', timeout: 30_000 })
    await screenshot('live-revised-storyboards')
    await panel().getByRole('button', { name: /Use these storyboards/ }).click()
    const completed = await waitForGoal('*', 'completed', 2_700_000)
    expect(completed.stages.videos!.outputs).toHaveLength(2)
    await inspect(completed, 'videos')
    expect(requests.filter(request => request.stage === 'videos').every(request => request.hasAudio && Math.abs(request.duration! - 4) <= 0.3)).toBe(true)
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
        const revised = completed.stages[stage]!.attempts?.some(attempt => attempt.artifactId === output.artifactId && attempt.feedback)
        expect(document.value.edges.filter(edge => edge.target === output.producerCellId)).toHaveLength((stage === 'frame' ? 2 : stage === 'storyboards' ? 3 : 1) + (revised ? 1 : 0))
      }
    }
    await status().click()
    await panel().getByRole('button', { name: 'Combine into one video', exact: true }).click()
    await expect.poll(async () => (await current(reviewed)).combined?.status, { timeout: 120_000 }).toBe('completed')
    const combined = await current(reviewed)
    const combinedPath = await mediaPath(combined.combined!.artifactId, 'video')
    const probe = await probeVideo(combinedPath)
    expect(probe.height).toBeGreaterThan(probe.width)
    expect(probe.hasAudio).toBe(true)
    expect(Math.abs(probe.duration - 8)).toBeLessThanOrEqual(0.3)
    expect((await call<GoalSnapshot>('video_goal', { action: 'combine', goal_id: reviewed.goalId })).combined?.artifactId).toBe(combined.combined!.artifactId)
    await checkpoint(combined)
    console.info(JSON.stringify({ goalId: reviewed.goalId, bookId, root, usage: await call('get_book_usage'), combinedPath, combined: probe }))
    await screenshot('live-complete')
    expect(errors).toEqual([])
  }, 5_400_000)

})
