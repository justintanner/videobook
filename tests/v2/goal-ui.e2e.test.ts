import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import express from 'express'
import sharp from 'sharp'
import { v7 as uuidv7 } from 'uuid'
import { chromium } from 'playwright'
import type { Browser, Locator, Page } from 'playwright'
import type { Engine } from 'videobook-engine'
import { firstEmptyNotebookGridSlot, notebookGridTag, notebookOccupiedSlots } from 'videobook-engine/notebook-grid'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine } from '../../server/src/book-context.js'
import { createHttpHandler } from '../../server/src/server.js'
import { configureProviderPollDriverForTests, queue, resetProviderPollDriverForTests, setEngineRoot, stopBookQueue, waitForBookQueuesIdleForTests } from '../../server/src/queue.js'
import { reconcileAwaitingNotebookOutputs, runNotebookCell } from '../../server/src/jobs/run-notebook.js'
import { readGoal, requireGoalShortContent, writeGoalShortContent } from '../../server/src/goal-store.js'
import { registerAllJobHandlers } from '../../server/src/jobs/index.js'
import { loadLegacyGoalFixture } from '../../server/src/test-legacy-goals.js'
import { uploadLocalStream } from '../../server/src/local-upload.js'
import { installFalDynamicEstimator } from '../../server/src/media/cost.js'
import { configureProviderEndpoints } from '../../server/src/media/endpoints.js'
import { copyVideoFixture } from '../../server/src/test-media-fixtures.js'
import { redirectFalStorage, startShortStub } from '../../server/src/test-short-stub.js'
import { testBudget } from '../../server/src/test-budget.js'
import { readTaggingSettings, writeTaggingSettings } from '../../server/src/tag-settings.js'
import type { GoalSnapshot, ShortGoalSnapshot } from '../../server/src/tools/goal.js'
import { availablePort, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

const live = process.env.VIDEOBOOK_RUN_MODEL_E2E === '1'
const scenario = live ? it.skip : it
const TITLE_OPTIONS = [
  { headline: 'รอรถเมล์กลางฝน', secondary: 'Waiting for the bus in the rain' },
  { headline: 'ฝนตกแต่รถเมล์ไม่มา', secondary: 'The rain came, the bus did not' },
  { headline: 'ใครเคยรอแบบนี้บ้าง', secondary: 'Who has waited like this?' },
]

function shortGoal(goal: GoalSnapshot | undefined): ShortGoalSnapshot {
  if (!goal || goal.legacy) throw new Error('expected a short')
  return goal
}

describe('goal mode in the browser', () => {
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
  const previousKeys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(await client.callTool({ name, arguments: { book_id: bookId, notebook_id: notebookId, ...args } })) as T
  const goals = () => call<{ goals: GoalSnapshot[] }>('video_goal', { action: 'list' })
  const current = (goal: GoalSnapshot) => call<GoalSnapshot>('video_goal', { action: 'status', goal_id: goal.goalId })
  const status = () => page.locator('.goal-status-button')
  const panel = () => page.locator('.goal-panel')
  const tile = (goal: GoalSnapshot) => page.locator(`.react-flow__node[data-id="${goal.cellId}"]`)
  const stepNames = (tabs: Locator) => tabs.getByRole('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
  const screenshot = async (name: string) => {
    if (process.env.VIDEOBOOK_GOAL_SCREENSHOTS) await page.screenshot({ path: join(process.env.VIDEOBOOK_GOAL_SCREENSHOTS, `${name}.png`) })
  }
  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: testBudget(30_000) }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
  }

  beforeAll(async () => {
    if (live) {
      if (!process.env.OPENAI_API_KEY) throw new Error('Live goal verification requires OPENAI_API_KEY')
    } else {
      process.env.OPENAI_API_KEY = 'test-goal-browser'
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
    app.post('/api/books/:bookId/upload', async (request, response) => {
      const book = books.get(String(request.params.bookId))
      if (!book.ok) { response.status(404).json({ error: book.error.message }); return }
      const result = await uploadLocalStream(book.value.engine, { bookId: book.value.bookId, filename: String(request.query.filename ?? ''), stream: request })
      if (!result.ok) { response.status(result.statusCode).json({ error: result.message }); return }
      response.json(result.value)
    })
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
    if (live) {
      const bytes = await readFile(new URL('../fixtures/goals/astronaut.png', import.meta.url))
      const asset = await call<{ assetId: string }>('upload_file', { filename: 'portrait-reference.png', data: bytes.toString('base64') })
      await call('create_notebook_cell', { cell: { type: 'image', slot: { row: 0, column: 2 }, output_artifact_id: asset.assetId } })
    }
    const vitePort = await availablePort()
    appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      ...process.env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
    })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(testBudget(10_000))
    page.setDefaultNavigationTimeout(testBudget(30_000))
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
  }, testBudget(60_000))

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
  }, testBudget(30_000))

  afterEach(async context => {
    if (context.task.result?.state === 'fail') {
      await screenshot('goal-failure')
      console.error(errors)
      console.error(await page.locator('body').innerText())
    }
    await page?.setViewportSize({ width: 1440, height: 1000 })
    for (const goal of (await goals()).goals) {
      if (['running', 'planning', 'review'].includes(goal.status)) await call('video_goal', { action: 'cancel', goal_id: goal.goalId })
    }
    await stopBookQueue(bookId)
    await queue.startBook(bookId)
  })

  scenario('makes a short from /goal without a mention: frame, clip, one continuation and finish with a written title', async () => {
    for (const goal of (await goals()).goals) {
      if (goal.status !== 'cancelled' && !goal.dismissedAt) await call('video_goal', { action: 'dismiss', goal_id: goal.goalId })
    }
    const fixtures = await mkdtemp(join(tmpdir(), 'videobook-goal-short-media-'))
    await copyVideoFixture({ width: 360, height: 640, durationSec: 3, fps: 12, source: 'color', color: 'green', audio: { frequency: 330 } }, join(fixtures, 'clip.mp4'))
    const clip = await readFile(join(fixtures, 'clip.mp4'))
    const stub = await startShortStub({ frame: await sharp({ create: { width: 360, height: 640, channels: 3, background: '#5b7a4c' } }).png().toBuffer(), clip, extended: clip })
    const savedKeys = { FAL_API_KEY: process.env.FAL_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    const savedTagging = readTaggingSettings(engine)
    writeTaggingSettings(engine, { analysisOnNewAssets: false })
    process.env.FAL_API_KEY = 'local-fal-key'
    process.env.OPENAI_API_KEY = 'offline-openai-key'
    const restoreFetch = redirectFalStorage(stub.baseURL)
    const restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL, openaiBaseURL: stub.baseURL })
    const restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: 'USD' }))
    configureProviderPollDriverForTests({ intervalMs: 200 })
    try {
      await page.reload()
      await command('/goal')
      await expect.poll(() => page.locator('.chat-bubble-assistant').last().textContent(), { timeout: testBudget(15_000) }).toContain('Describe the short, for example /goal he waits for a bus in the rain')
      stub.plannerAnswers = [{ title: 'Bus in the rain', frame: 'He stands under a bus shelter at dusk, rain on the road.', beats: ['He checks the road for the bus, then wipes rain from his sleeve.'] }]
      const brief = 'he waits for a bus in the rain'
      await command(`/goal ${brief}`)
      await expect.poll(async () => (await goals()).goals.find(goal => goal.brief === brief)?.status, { timeout: testBudget(30_000) }).toBe('review')
      const short = shortGoal((await goals()).goals.find(goal => goal.brief === brief))
      expect(short).toMatchObject({ planVersion: 5, shortPlan: { version: 5, title: 'Bus in the rain', segments: [{ seconds: 12 }] } })
      expect(JSON.stringify(short)).not.toMatch(/nano-banana|seedance|kie:/iu)
      expect(JSON.stringify(short)).not.toMatch(/Main character|a man in a green shirt/)
      expect(stub.plannerRequests).toHaveLength(1)
      if (savedKeys.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = savedKeys.OPENAI_API_KEY
      const tabs = panel().getByRole('navigation', { name: 'Goal steps' })
      const openTab = async (name: string) => {
        if (!(await panel().isVisible())) {
          await tile(short).click()
          await panel().waitFor({ state: 'visible', timeout: testBudget(15_000) })
        }
        await tabs.getByRole('button', { name, exact: true }).click()
      }
      const primary = (label: RegExp) => panel().locator('.goal-panel-bar .goal-panel-primary', { hasText: label })
      await tile(short).waitFor({ state: 'visible', timeout: testBudget(15_000) })
      if (!(await panel().isVisible())) {
        await tile(short).click()
        await panel().waitFor({ state: 'visible', timeout: testBudget(15_000) })
      }
      expect(await tabs.getByRole('button', { name: 'Frame', exact: true }).getAttribute('aria-current')).toBe('step')
      expect(await stepNames(tabs)).toEqual(['Recipe', 'Frame', 'Video', 'Finish'])
      await expect.poll(() => status().textContent(), { timeout: testBudget(15_000) }).toContain('Generate the frame · $0.21')
      expect(await panel().locator('.goal-panel-status').textContent()).toBe('Generate the frame · $0.21')
      expect(await primary(/^Generate frame/).isDisabled()).toBe(false)
      expect(await panel().getByText('No reference image for Main character, so the frame is generated from the description.').count()).toBe(0)
      await screenshot('goal-frame-first')
      await expect.poll(() => primary(/^Generate frame · \$0\.21$/).isEnabled(), { timeout: testBudget(30_000) }).toBe(true)
      await primary(/^Generate frame/).click()
      await expect.poll(() => status().textContent(), { timeout: testBudget(90_000) }).toContain('Generate clip 1 of 1 · at least $')

      await openTab('Video')
      await panel().getByLabel('New beat', { exact: true }).fill('He steps back from a splash and boards the bus.')
      await panel().getByLabel('New beat seconds', { exact: true }).fill('5')
      await panel().getByRole('button', { name: 'Add beat', exact: true }).click()
      await expect.poll(async () => shortGoal(await current(short)).shortPlan?.segments.map(segment => segment.seconds), { timeout: testBudget(15_000) }).toEqual([12, 5])
      await openTab('Video')
      await primary(/^Generate clip · at least \$/).click()
      await expect.poll(() => status().textContent(), { timeout: testBudget(120_000) }).toContain('Generate clip 2 of 2 · at least $')
      await openTab('Video')
      expect(await panel().getByLabel('Current clip', { exact: true }).isVisible()).toBe(true)
      await primary(/^Continue · clip 2 · at least \$/).click()
      await expect.poll(() => status().textContent(), { timeout: testBudget(120_000) }).toContain('Ready to finish · 0:17')

      await openTab('Finish')
      const writeTitle = panel().getByRole('button', { name: /^Write title · \$\d+\.\d\d$/u })
      await writeTitle.waitFor({ state: 'visible', timeout: testBudget(15_000) })
      expect(await panel().getByLabel('Burned title', { exact: true }).inputValue()).toBe('')
      process.env.OPENAI_API_KEY = 'offline-openai-key'
      stub.plannerAnswers = [{ options: TITLE_OPTIONS }]
      await writeTitle.click()
      const titleOptions = panel().getByRole('list', { name: 'Title options' })
      await titleOptions.waitFor({ state: 'visible', timeout: testBudget(30_000) })
      expect(stub.plannerRequests).toHaveLength(2)
      if (savedKeys.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = savedKeys.OPENAI_API_KEY
      await titleOptions.getByRole('button', { name: /ฝนตกแต่รถเมล์ไม่มา/u }).click()
      expect(await panel().getByLabel('Burned title', { exact: true }).inputValue()).toBe('ฝนตกแต่รถเมล์ไม่มา')
      await panel().getByLabel('English line', { exact: true }).fill('The rain came. The bus did not.')
      expect(await primary(/^Finish$/).isDisabled()).toBe(true)
      await panel().getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(async () => shortGoal(await current(short)).shortPlan?.finish.title, { timeout: testBudget(15_000) })
        .toEqual({ headline: 'ฝนตกแต่รถเมล์ไม่มา', secondary: 'The rain came. The bus did not.' })
      await screenshot('goal-finish-title')
      await openTab('Finish')
      await expect.poll(() => primary(/^Finish$/).isEnabled(), { timeout: testBudget(30_000) }).toBe(true)
      await primary(/^Finish$/).click()
      await expect.poll(() => status().textContent(), { timeout: testBudget(240_000) }).toContain('Short ready · 0:17')
      const rendered = shortGoal(await current(short))
      const provenance = await engine.files.read(rendered.finalArtifactId!, 'goal-finish.json')
      if (!provenance.ok) throw new Error(provenance.error.message)
      expect(JSON.parse(provenance.value.toString())).toMatchObject({ title: { headline: 'ฝนตกแต่รถเมล์ไม่มา', secondary: 'The rain came. The bus did not.' } })
      await openTab('Finish')
      const finished = panel().getByLabel('Finished short', { exact: true })
      await finished.waitFor({ state: 'visible', timeout: testBudget(30_000) })
      await expect.poll(() => finished.evaluate(node => (node as HTMLVideoElement).readyState), { timeout: testBudget(30_000) }).toBeGreaterThan(0)
      expect(stub.submissions.map(submission => submission.path)).toEqual(['/openai/gpt-image-2.6/sunburst/text-to-image', '/minimax/h3-max/reference-to-video', '/minimax/h3-max/extend-video'])
      expect(stub.unexpected).toEqual([])
      expect(errors).toEqual([])
    } finally {
      resetProviderPollDriverForTests()
      restoreEstimator()
      restoreEndpoints()
      restoreFetch()
      await stub.close()
      for (const [key, value] of Object.entries(savedKeys)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      writeTaggingSettings(engine, savedTagging)
      await rm(fixtures, { recursive: true, force: true })
    }
  }, testBudget(600_000))


  scenario('keeps a saved version 5 remix working through replacement, twist, video and finish', async () => {
    for (const goal of (await goals()).goals) {
      if (goal.status !== 'cancelled' && !goal.dismissedAt) await call('video_goal', { action: 'dismiss', goal_id: goal.goalId })
    }
    const fixtures = await mkdtemp(join(tmpdir(), 'videobook-goal-storyboard-media-'))
    await copyVideoFixture({ width: 360, height: 640, durationSec: 6, fps: 12, source: 'color', color: '0x4f6b3a', audio: false }, join(fixtures, 'umbrella.mp4'))
    await copyVideoFixture({ width: 360, height: 640, durationSec: 3, fps: 12, source: 'color', color: 'green', audio: { frequency: 330 } }, join(fixtures, 'clip.mp4'))
    const clip = await readFile(join(fixtures, 'clip.mp4'))
    const stub = await startShortStub({ frame: await sharp({ create: { width: 360, height: 640, channels: 3, background: '#5b7a4c' } }).png().toBuffer(), clip, extended: clip })
    const savedKeys = { FAL_API_KEY: process.env.FAL_API_KEY, KIE_API_KEY: process.env.KIE_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    const savedTagging = readTaggingSettings(engine)
    writeTaggingSettings(engine, { analysisOnNewAssets: false })
    process.env.FAL_API_KEY = 'local-fal-key'
    process.env.KIE_API_KEY = 'local-kie-key'
    process.env.OPENAI_API_KEY = 'offline-openai-key'
    const restoreFetch = redirectFalStorage(stub.baseURL)
    const restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL, kieBaseURL: stub.baseURL, kieUploadBaseURL: stub.baseURL, openaiBaseURL: stub.baseURL })
    const restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: 'USD' }))
    configureProviderPollDriverForTests({ intervalMs: 200 })
    try {
      const video = await engine.artifacts.create('video', 'Umbrella walk')
      if (!video.ok) throw new Error(video.error.message)
      const written = await engine.files.writeFromPath(video.value.artifactId, 'original.mp4', join(fixtures, 'umbrella.mp4'))
      if (!written.ok) throw new Error(written.error.message)
      const before = engine.notebooks.read(notebookId)
      if (!before.ok) throw new Error(before.error.message)
      const slot = firstEmptyNotebookGridSlot(notebookOccupiedSlots(before.value.cells))
      const inserted = await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: 'video', label: 'Umbrella walk', slot, outputArtifactId: video.value.artifactId }))
      if (!inserted.ok) throw new Error(inserted.error.message)
      const labelOf = (artifactId: string | undefined) => {
        const artifact = artifactId ? engine.artifacts.get(artifactId) : null
        return artifact?.ok ? artifact.value.label : null
      }
      const photo = before.value.cells.find(cell => cell.type === 'image' && labelOf(cell.outputArtifactId) === 'character-2')
      if (!photo) throw new Error('missing the second character image')
      await page.reload()
      stub.plannerAnswers = [{ title: 'Umbrella for a lizard', replacement: 'Replace the man with the man from the source image, preserving his clothes and the original pose.', frame: 'A man holds a red umbrella over a monitor lizard on a wet lane.', beats: ['He walks beside the lizard, keeping the umbrella over it as rain falls.'] }]
      const brief = `make a 12s clip based on ${notebookGridTag(slot)} but with ${notebookGridTag(photo.slot)} holding the umbrella for a monitor lizard`
      await command(`/goal ${brief}`)
      await expect.poll(async () => (await goals()).goals.find(goal => goal.brief === brief)?.status, { timeout: testBudget(60_000) }).toBe('review')
      const analyzed = shortGoal((await goals()).goals.find(goal => goal.brief === brief))
      const stored = readGoal(engine, analyzed.goalId)
      const content = requireGoalShortContent(engine, stored)
      if (content.plan?.version !== 5) throw new Error('expected version 5')
      const { analysis: _analysis, ...savedPlan } = content.plan
      await writeGoalShortContent(engine, stored, { ...content, plan: savedPlan, draft: null })
      const short = shortGoal(await current(analyzed))
      await page.reload()
      expect(short).toMatchObject({ planVersion: 5, stage: 'replacement', shortPlan: { version: 5, remix: { video: { artifactId: video.value.artifactId } } } })
      expect(short.storyboard).toBeNull()
      expect(short.shortPlan?.version === 5 && short.shortPlan.remix?.frame.atSeconds).toBe(3)
      expect(stub.plannerRequests).toHaveLength(1)
      if (savedKeys.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = savedKeys.OPENAI_API_KEY
      const tabs = panel().getByRole('navigation', { name: 'Goal steps' })
      const openTab = async (name: string) => {
        if (!(await panel().isVisible())) {
          await tile(short).click()
          await panel().waitFor({ state: 'visible', timeout: testBudget(15_000) })
        }
        await tabs.getByRole('button', { name, exact: true }).click()
      }
      const primary = (label: RegExp) => panel().locator('.goal-panel-bar .goal-panel-primary', { hasText: label })
      await tile(short).waitFor({ state: 'visible', timeout: testBudget(15_000) })
      if (!(await panel().isVisible())) {
        await tile(short).click()
        await panel().waitFor({ state: 'visible', timeout: testBudget(15_000) })
      }
      await expect.poll(() => stepNames(tabs), { timeout: testBudget(15_000) }).toEqual(['Character', 'Twist', 'Video', 'Finish'])
      expect(await tabs.getByRole('button', { name: 'Character', exact: true }).getAttribute('aria-current')).toBe('step')
      await expect.poll(() => status().textContent(), { timeout: testBudget(15_000) }).toContain('Replace the character · $0.21')
      expect(await tile(short).locator('.goal-tile-row-title').allTextContents()).toEqual(['Extract frame', 'Replace character'])
      expect(await panel().getByRole('button', { name: /^Open Extracted source frame/ }).count()).toBe(1)
      await openTab('Twist')
      expect(await primary(/^Add twist/).count()).toBe(0)
      await panel().getByRole('button', { name: /^Go to Character/ }).click()
      expect(await tabs.getByRole('button', { name: 'Character', exact: true }).getAttribute('aria-current')).toBe('step')
      await screenshot('goal-replace-first')
      await primary(/^Replace character/).click()
      await expect.poll(() => status().textContent(), { timeout: testBudget(120_000) }).toContain('Add the twist · $0.21')
      expect(await tile(short).locator('.goal-tile-row-title').allTextContents()).toEqual(['Twist'])
      await page.reload()
      await tile(short).waitFor({ state: 'visible', timeout: testBudget(15_000) })
      await openTab('Character')
      expect(await panel().getByRole('button', { name: 'Replacement v1', exact: true }).count()).toBe(1)
      await openTab('Twist')
      expect(await panel().getByRole('button', { name: 'Open Reviewed replacement', exact: true }).count()).toBe(1)
      await screenshot('goal-twist-review')
      await expect.poll(() => primary(/^Add twist/).isEnabled(), { timeout: testBudget(30_000) }).toBe(true)
      await primary(/^Add twist/).click()
      await expect.poll(() => status().textContent(), { timeout: testBudget(90_000) }).toContain('Generate clip 1 of 1 · at least $')
      await openTab('Video')
      const references = panel().getByLabel('Video references', { exact: true })
      const sourceVideo = references.getByRole('button', { name: /^Open @video1 · Source video/ })
      expect(await sourceVideo.textContent()).toContain('Preview pending')
      expect(await sourceVideo.locator('img').count()).toBe(0)
      expect(await references.getByRole('button', { name: 'Open @image1 · Reviewed twist', exact: true }).count()).toBe(1)
      await screenshot('goal-video-references')
      await primary(/^Generate clip · at least \$/).click()
      await expect.poll(() => status().textContent(), { timeout: testBudget(120_000) }).toContain('Ready to finish · 0:12')
      await openTab('Finish')
      await expect.poll(() => primary(/^Finish$/).isEnabled(), { timeout: testBudget(30_000) }).toBe(true)
      await primary(/^Finish$/).click()
      await expect.poll(() => status().textContent(), { timeout: testBudget(240_000) }).toContain('Short ready · 0:12')
      expect(stub.submissions.map(submission => submission.path)).toEqual([
        '/openai/gpt-image-2.6/sunburst/edit', '/openai/gpt-image-2.6/sunburst/edit', '/minimax/h3-max/reference-to-video',
      ])
      expect(stub.submissions.at(-1)!.body).toMatchObject({ reference_video_urls: [expect.any(String)], reference_image_urls: [expect.any(String)] })
      expect(stub.submissions.at(-1)!.body).not.toHaveProperty('image_url')
      expect(stub.unexpected).toEqual([])
      expect(errors).toEqual([])
    } finally {
      resetProviderPollDriverForTests()
      restoreEstimator()
      restoreEndpoints()
      restoreFetch()
      await stub.close()
      for (const [key, value] of Object.entries(savedKeys)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      writeTaggingSettings(engine, savedTagging)
      await rm(fixtures, { recursive: true, force: true })
    }
  }, testBudget(600_000))

  scenario('reviews the retained action on desktop and mobile before assembling the source montage', async () => {
    const fixtures = await mkdtemp(join(tmpdir(), 'videobook-goal-action-ui-'))
    await copyVideoFixture({ width: 180, height: 320, durationSec: 6, fps: 12, source: 'color', color: 'green', audio: false }, join(fixtures, 'source.mp4'))
    await copyVideoFixture({ width: 180, height: 320, durationSec: 3, fps: 12, source: 'color', color: 'yellow', audio: false }, join(fixtures, 'clip.mp4'))
    const clip = await readFile(join(fixtures, 'clip.mp4'))
    const stub = await startShortStub({ frame: await sharp({ create: { width: 180, height: 320, channels: 3, background: '#7c9a4f' } }).png().toBuffer(), clip, extended: clip })
    const savedKeys = { FAL_API_KEY: process.env.FAL_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    const savedTagging = readTaggingSettings(engine)
    writeTaggingSettings(engine, { analysisOnNewAssets: false })
    process.env.FAL_API_KEY = 'local-fal-key'
    delete process.env.OPENAI_API_KEY
    const restoreFetch = redirectFalStorage(stub.baseURL)
    const restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL, openaiBaseURL: stub.baseURL })
    const restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: 'USD' }))
    configureProviderPollDriverForTests({ intervalMs: 200 })
    try {
      for (const goal of (await goals()).goals) {
        if (['planning', 'review', 'running'].includes(goal.status)) await call('video_goal', { action: 'cancel', goal_id: goal.goalId })
      }
      const source = await engine.artifacts.create('video', 'Action source')
      if (!source.ok) throw new Error(source.error.message)
      await engine.files.writeFromPath(source.value.artifactId, 'original.mp4', join(fixtures, 'source.mp4'))
      const notebook = engine.notebooks.read(notebookId)
      if (!notebook.ok) throw new Error(notebook.error.message)
      const slot = firstEmptyNotebookGridSlot(notebookOccupiedSlots(notebook.value.cells))
      await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: 'video', slot, outputArtifactId: source.value.artifactId }))
      const brief = `A 6 second montage from ${notebookGridTag(slot)}. The man is absent for the first 4 seconds and appears in the final two seconds. Mute. Keep source graphics. replace: "Insert the man beside the display." frame: "He is ready to wave." video: "Keep the montage. The man waves in the final two seconds."`
      await page.reload()
      await command(`/goal ${brief}`)
      await expect.poll(async () => (await goals()).goals.find(goal => goal.brief === brief)?.status, { timeout: testBudget(60_000) }).toBe('review')
      let goal = shortGoal((await goals()).goals.find(candidate => candidate.brief === brief))
      for (let stage = 0; stage < 3; stage++) {
        goal = shortGoal(await call<GoalSnapshot>('video_goal', { action: 'approve', goal_id: goal.goalId, revision: goal.revision }))
        await expect.poll(async () => { goal = shortGoal(await current(goal)); return goal.status }, { timeout: testBudget(90_000) }).toBe('review')
      }
      const firstClip = goal.stages.videos!.outputs[0]!.artifactId
      const beforeRerun = engine.notebooks.read(notebookId)
      if (!beforeRerun.ok) throw new Error(beforeRerun.error.message)
      const producer = beforeRerun.value.cells.find(cell => cell.id === goal.stages.videos!.outputs[0]!.producerCellId)!
      const manualPrompt = 'The man waves with both hands, then lowers them. Complete the wave within two seconds.'
      const edited = { ...producer, prompt: manualPrompt }
      const rerunDocument = { ...beforeRerun.value, cells: beforeRerun.value.cells.map(cell => cell.id === producer.id ? edited : cell) }
      await engine.notebooks.write(rerunDocument)
      const manual = await runNotebookCell(engine, bookId, notebookId, rerunDocument, edited, { confirmPaid: true, runId: uuidv7() })
      await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) })
      await reconcileAwaitingNotebookOutputs(engine, bookId)
      await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) })
      goal = shortGoal(await current(goal))
      expect(goal.finish?.sourceArtifactId).toBe(firstClip)
      await page.reload()
      await tile(goal).waitFor({ state: 'visible', timeout: testBudget(30_000) })
      if (!(await panel().isVisible())) await tile(goal).click()
      await panel().getByRole('button', { name: /^\d+ takes?$/u }).click()
      const history = panel().locator('.goal-take-history')
      const take = history.locator('.goal-take-entry').filter({ has: page.getByText(manualPrompt, { exact: true }) })
      await take.locator(':scope > summary').click()
      const adopt = take.getByRole('button', { name: 'Use reviewed take', exact: true })
      expect(await adopt.isDisabled()).toBe(true)
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
        await page.setViewportSize(viewport)
        await take.scrollIntoViewIfNeeded()
        expect(await take.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      }
      await take.getByLabel('I reviewed this take for the current brief', { exact: true }).check()
      await adopt.click()
      await expect.poll(async () => shortGoal(await current(goal)).finish?.sourceArtifactId, { timeout: testBudget(30_000) }).toBe(manual.outputArtifactId)
      const tabs = panel().getByRole('navigation', { name: 'Goal steps' })
      await tabs.getByRole('button', { name: 'Video', exact: true }).click()
      expect(await panel().getByLabel('Changed action prompt', { exact: true }).isVisible()).toBe(true)
      expect(await panel().getByRole('button', { name: 'Add beat', exact: true }).count()).toBe(0)
      await tabs.getByRole('button', { name: 'Finish', exact: true }).click()
      const finish = panel().locator('.goal-panel-bar .goal-panel-primary', { hasText: /^Finish$/ })
      expect(await finish.count()).toBe(0)
      expect(await panel().locator('.goal-next').textContent()).toContain('Choose which part of the take goes into the short')
      await panel().getByRole('button', { name: /^Go to Video/ }).click()
      const window = panel().getByRole('group', { name: 'Retained action window' })
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
        await page.setViewportSize(viewport)
        await window.scrollIntoViewIfNeeded()
        expect(await window.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      }
      await window.getByLabel('Retained action start seconds').fill('1')
      await screenshot('goal-action-window-mobile')
      await panel().locator('.goal-panel-bar .goal-panel-primary', { hasText: /^Use this window$/ }).click()
      await expect.poll(async () => shortGoal(await current(goal)).actionWindow?.startFrame, { timeout: testBudget(30_000) }).toBe(12)
      await expect.poll(() => window.getByText('Saved for the short').count(), { timeout: testBudget(15_000) }).toBe(1)
      await tabs.getByRole('button', { name: 'Recipe', exact: true }).click()
      const initial = panel().locator('.goal-recipe')
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
        await page.setViewportSize(viewport)
        await initial.scrollIntoViewIfNeeded()
        const widths = await initial.evaluate(element => ({ content: element.scrollWidth, available: element.clientWidth }))
        expect(widths.content, `${viewport.width}px: ${JSON.stringify(widths)}`).toBeLessThanOrEqual(widths.available + 1)
      }
      await initial.getByLabel('Apply saved branding', { exact: true }).uncheck()
      await initial.getByRole('group', { name: 'Remix audio', exact: true }).getByRole('button', { name: 'Generated', exact: true }).click()
      await initial.getByLabel('Offer automatic continuation for this recipe', { exact: true }).check()
      await initial.getByLabel('Default continuation allowance USD', { exact: true }).fill('0')
      await initial.getByRole('button', { name: 'Use current book branding', exact: true }).click()
      await expect.poll(async () => {
        goal = shortGoal(await current(goal))
        return goal.shortPlan?.version === 5 ? goal.shortPlan.analysis?.preferences.branding : null
      }, { timeout: testBudget(30_000) }).toBe(false)
      expect(goal.actionWindow?.startFrame).toBe(12)
      expect(goal.stages.videos!.outputs[0]).toMatchObject({ artifactId: manual.outputArtifactId, stale: null })
      await tabs.getByRole('button', { name: 'Finish', exact: true }).click()
      await expect.poll(() => finish.isEnabled(), { timeout: testBudget(30_000) }).toBe(true)
      await panel().getByRole('button', { name: 'Run the rest…', exact: true }).click()
      const automatic = panel().getByRole('region', { name: 'Automatic continuation', exact: true })
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
        await page.setViewportSize(viewport)
        await automatic.scrollIntoViewIfNeeded()
        expect(await automatic.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      }
      expect(await automatic.getByLabel('Continuation allowance USD', { exact: true }).inputValue()).toBe('0')
      await screenshot('goal-automatic-finish-mobile')
      await automatic.getByRole('button', { name: 'Run reviewed recipe', exact: true }).click()
      await expect.poll(async () => shortGoal(await current(goal)).finish?.status, { timeout: testBudget(120_000) }).toBe('completed')
      await expect.poll(async () => shortGoal(await current(goal)).automation?.status, { timeout: testBudget(30_000) }).toBe('completed')
      expect(shortGoal(await current(goal)).automation?.reservations).toEqual([])
      expect(stub.submissions).toHaveLength(4)
      expect(stub.submissions.at(-1)!.body.duration).toBe(2)
      expect(stub.unexpected).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await stopBookQueue(bookId)
      resetProviderPollDriverForTests()
      restoreEstimator()
      restoreEndpoints()
      restoreFetch()
      await stub.close()
      for (const [key, value] of Object.entries(savedKeys)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      writeTaggingSettings(engine, savedTagging)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await rm(fixtures, { recursive: true, force: true })
    }
  }, testBudget(240_000))

  scenario('prepares and reuses a reviewed source with the shared mask editor on desktop and mobile', async () => {
    const fixtures = await mkdtemp(join(tmpdir(), 'videobook-goal-preparation-ui-'))
    try {
      for (const goal of (await goals()).goals) {
        if (!goal.dismissedAt && ['planning', 'review', 'running'].includes(goal.status)) await call('video_goal', { action: 'cancel', goal_id: goal.goalId })
      }
      await copyVideoFixture({ width: 180, height: 320, durationSec: 6, fps: 12, source: 'color', color: 'green', audio: false }, join(fixtures, 'source.mp4'))
      const video = await engine.artifacts.create('video', 'Preparation source')
      if (!video.ok) throw new Error(video.error.message)
      await engine.files.writeFromPath(video.value.artifactId, 'original.mp4', join(fixtures, 'source.mp4'))
      const notebook = engine.notebooks.read(notebookId)
      if (!notebook.ok) throw new Error(notebook.error.message)
      const slot = firstEmptyNotebookGridSlot(notebookOccupiedSlots(notebook.value.cells))
      await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: 'video', slot, outputArtifactId: video.value.artifactId }))
      const brief = (address: string) => `A 6s video from ${address}. Mute. Remove all source graphics. replace: "Insert the man by the display." frame: "He waits beside the display." video: "The man waves."`
      await page.reload()
      await command(`/goal ${brief(notebookGridTag(slot))}`)
      await expect.poll(async () => (await goals()).goals.find(goal => goal.brief === brief(notebookGridTag(slot)))?.status, { timeout: testBudget(60_000) }).toBe('review')
      const goal = shortGoal((await goals()).goals.find(goal => goal.brief === brief(notebookGridTag(slot))))
      await tile(goal).waitFor({ state: 'visible', timeout: testBudget(30_000) })
      if (!(await panel().isVisible())) await tile(goal).click()
      const preparation = panel().locator('.goal-source-preparation')
      await preparation.waitFor({ state: 'visible', timeout: testBudget(15_000) })
      expect(await panel().locator('.goal-panel-bar .goal-panel-primary', { hasText: /^Insert character/ }).count()).toBe(0)
      expect(await panel().locator('.goal-next').textContent()).toContain('Prepare the source: mark the on-screen graphics to remove.')
      await preparation.getByLabel('Goal removal method').selectOption('fill')
      await preparation.getByRole('button', { name: 'Add region', exact: true }).click()
      for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
        await page.setViewportSize(size)
        await expect.poll(async () => {
          const box = await preparation.locator('.cleanup-stage').boundingBox()
          return box ? Math.abs(box.width / box.height - 180 / 320) : 1
        }).toBeLessThan(0.02)
        expect(await preparation.locator('.video-cleanup-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      }
      await screenshot('goal-source-masks-mobile')
      await page.setViewportSize({ width: 1440, height: 1000 })
      await preparation.getByLabel('I reviewed the regions and kept physical scene details.').check()
      await preparation.getByRole('button', { name: 'Prepare cleaned source', exact: true }).click()
      await expect.poll(async () => shortGoal(await current(goal)).preparation?.status, { timeout: testBudget(60_000) }).toBe('review')
      const recipe = shortGoal(await current(goal)).shortPlan
      if (recipe?.version !== 5 || !recipe.analysis?.recipe.preparedArtifactId) throw new Error('Expected prepared source')
      const preparedId = recipe.analysis.recipe.preparedArtifactId
      expect(preparedId).not.toBe(video.value.artifactId)
      await expect.poll(() => preparation.getByLabel('Prepared source video').getAttribute('src'), { timeout: testBudget(30_000) }).toContain(preparedId)
      expect(await panel().locator('.goal-panel-bar .goal-panel-primary', { hasText: /^Insert character/ }).count()).toBe(0)
      await expect.poll(() => panel().locator('.goal-next').textContent(), { timeout: testBudget(15_000) }).toContain('Watch the cleaned source, then press Use reviewed source.')
      await screenshot('goal-cleaned-source-review')
      await preparation.getByLabel('The graphics are removed, the fill looks acceptable, and the sound is intact.').check()
      await preparation.getByRole('button', { name: 'Use reviewed source', exact: true }).click()
      await expect.poll(async () => shortGoal(await current(goal)).preparation?.status, { timeout: testBudget(15_000) }).toBe('ready')
      await expect.poll(() => panel().locator('.goal-panel-bar .goal-panel-primary', { hasText: /^Insert character/ }).isEnabled()).toBe(true)
      await call('video_goal', { action: 'cancel', goal_id: goal.goalId })
      const arranged = engine.notebooks.read(notebookId)
      if (!arranged.ok) throw new Error(arranged.error.message)
      const sourceCell = arranged.value.cells.find(cell => cell.outputArtifactId === video.value.artifactId)!
      await command(`/goal ${brief(notebookGridTag(sourceCell.slot))}`)
      await expect.poll(async () => (await goals()).goals.filter(candidate => candidate.goalId !== goal.goalId && candidate.status === 'review').length, { timeout: testBudget(60_000) }).toBe(1)
      const next = shortGoal((await goals()).goals.find(candidate => candidate.goalId !== goal.goalId && candidate.status === 'review'))
      if (!(await preparation.isVisible())) await tile(next).click()
      await preparation.getByLabel('Existing cleaned copy').selectOption(preparedId)
      await preparation.getByLabel('I reviewed the regions and kept physical scene details.').check()
      await preparation.getByRole('button', { name: 'Use existing cleaned copy', exact: true }).click()
      await expect.poll(async () => shortGoal(await current(next)).preparation?.status, { timeout: testBudget(60_000) }).toBe('ready')
      const reused = shortGoal(await current(next)).shortPlan
      expect(reused?.version === 5 && reused.analysis?.recipe.preparedArtifactId).toBe(preparedId)
      await call('video_goal', { action: 'cancel', goal_id: next.goalId })
      expect(errors).toEqual([])
    } finally {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await rm(fixtures, { recursive: true, force: true })
    }
  }, testBudget(180_000))

  scenario('shows goals from an earlier /goal as read-only summaries whose outputs open their cells', async () => {
    const image = await sharp({ create: { width: 90, height: 160, channels: 3, background: '#7a6a4f' } }).png().toBuffer()
    const fixtures = await mkdtemp(join(tmpdir(), 'videobook-goal-legacy-media-'))
    try {
      await copyVideoFixture({ width: 90, height: 160, durationSec: 2, fps: 12, source: 'color', color: 'blue', audio: { frequency: 330 } }, join(fixtures, 'clip.mp4'))
      const video = await readFile(join(fixtures, 'clip.mp4'))
      const boards = await loadLegacyGoalFixture(engine, notebookId, 'v2-four-panel', { image, video })
      const finished = await loadLegacyGoalFixture(engine, notebookId, 'v3-finished', { image, video })
      await page.reload()
      const listed = (await goals()).goals
      const earlier = listed.find(goal => goal.goalId === boards.goalId)
      const scene = listed.find(goal => goal.goalId === finished.goalId)
      if (!earlier?.legacy || !scene?.legacy) throw new Error('expected two earlier goals')
      expect(earlier.outputs.map(output => output.stage)).toEqual(['frame', 'storyboards', 'storyboards', 'videos', 'videos'])
      await tile(earlier).waitFor({ state: 'visible', timeout: testBudget(30_000) })
      await expect.poll(() => tile(earlier).textContent(), { timeout: testBudget(15_000) }).toContain('Made by an earlier /goal')
      await tile(earlier).click()
      await panel().waitFor({ state: 'visible', timeout: testBudget(15_000) })
      expect(await panel().getByText('Made by an earlier /goal.', { exact: false }).isVisible()).toBe(true)
      expect(await panel().getByRole('navigation', { name: 'Goal steps' }).count()).toBe(0)
      const outputs = panel().getByRole('list', { name: 'Outputs' }).getByRole('button')
      expect(await outputs.allTextContents()).toEqual(earlier.outputs.map(output => output.address))
      const target = earlier.outputs[1]!
      await outputs.nth(1).click()
      await expect.poll(() => page.locator(`.react-flow__node[data-id="${target.cellId}"] [data-selection="primary"]`).count(), { timeout: testBudget(15_000) }).toBe(1)
      await tile(scene).click()
      await panel().getByLabel('Finished video', { exact: true }).waitFor({ state: 'visible', timeout: testBudget(15_000) })
      await panel().getByRole('button', { name: 'Dismiss', exact: true }).click()
      await expect.poll(async () => (await current(scene)).dismissedAt, { timeout: testBudget(15_000) }).toEqual(expect.any(String))
      expect(errors).toEqual([])
    } finally {
      await rm(fixtures, { recursive: true, force: true })
    }
  }, testBudget(120_000))
})
