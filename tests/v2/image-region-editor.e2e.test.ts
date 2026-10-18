import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import express from 'express'
import { chromium } from 'playwright'
import type { Browser, Page, Request } from 'playwright'
import type { NotebookCell } from 'videobook-engine'
import sharp from 'sharp'
import { runFfmpeg } from '../../server/src/ffmpeg.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine } from '../../server/src/book-context.js'
import { createHttpHandler } from '../../server/src/server.js'
import { resolveImageSubjectSource } from '../../server/src/image-subject-map.js'
import { reconcileImageSubjectJobFailures } from '../../server/src/jobs/image-subjects.js'
import { failPendingTaskAndLog } from '../../server/src/jobs/task-failure.js'
import { abortActiveBookJobsForTests, pauseBookQueueForTests, queue, setEngineRoot } from '../../server/src/queue.js'
import { availablePort, record, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { ObservedToolCall, StartedProcess } from './e2e-harness.js'

describe('drawn region image editor through real MCP', () => {
  let rootDir = ''
  let server: Server | undefined
  let books: BookManager
  let vite: StartedProcess | undefined
  let browser: Browser | undefined
  let page: Page
  let client: Client
  let bookId = ''
  let notebookId = ''
  let sourceCellId = ''
  const observed: ObservedToolCall[] = []

  async function call(name: string, args: Record<string, unknown> = {}) {
    return resultValue(await client.callTool({
      name, arguments: { book_id: bookId, notebook_id: notebookId, ...args },
    }))
  }

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-region-editor-'))
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    const origin = `http://127.0.0.1:${mcpPort}`
    const appUrl = `http://127.0.0.1:${vitePort}`
    const env = {
      ...process.env,
      PORT: String(mcpPort),
      KIE_API_KEY: '',
      FAL_API_KEY: '',
      VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
      VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime/app-state.json'),
    }
    books = new BookManager({ libraryDir: env.VIDEOBOOK_LIBRARY_DIR })
    await books.ready()
    const mcp = toNodeHandler(createHttpHandler(scopedBookEngine, books))
    const app = express()
    app.use(express.json())
    app.all('/mcp', (request, response) => { void mcp(request, response, request.body) })
    app.get(/^\/files\/([^/]+)\/([^/]+)\/(.+)$/, async (request, response) => {
      const book = books.get(String(request.params[0]))
      if (!book.ok) { response.sendStatus(404); return }
      const file = await book.value.engine.files.read(String(request.params[1]), String(request.params[2]))
      if (!file.ok) { response.sendStatus(404); return }
      response.setHeader('Accept-Ranges', 'bytes')
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        const end = Math.min(Number(range[2] || file.value.length - 1), file.value.length - 1)
        response.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${file.value.length}`)
        response.type(String(request.params[2])).send(file.value.subarray(start, end + 1))
        return
      }
      response.type(String(request.params[2])).send(file.value)
    })
    server = createServer(app)
    await new Promise<void>((resolve) => server!.listen(mcpPort, '127.0.0.1', resolve))
    client = new Client({ name: 'image-region-editor-e2e', version: '1.0.0' }, {
      capabilities: {},
      supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    bookId = String(record(await call('create_book', { name: 'region-editor' }))?.bookId ?? '')
    const notebooks = await call('list_notebooks')
    notebookId = String(record(Array.isArray(notebooks) ? notebooks[0] : null)?.id ?? '')
    const book = books.get(bookId)
    if (!book.ok) throw new Error(book.error.message)
    const { engine, rootDir: bookRoot } = book.value
    await setEngineRoot(bookRoot, engine)
    await pauseBookQueueForTests(bookId)
    for (const [column, background] of ['#b45028', '#2878b4'].entries()) {
      const bytes = await sharp({ create: { width: 300, height: 200, channels: 3, background } }).png().toBuffer()
      const asset = await engine.artifacts.create('image', `image-${column}`)
      if (!asset.ok) throw new Error(asset.error.message)
      const written = await engine.files.write(asset.value.artifactId, 'original.png', bytes)
      if (!written.ok) throw new Error(written.error.message)
      const cell = record(await call('create_notebook_cell', {
        cell: { type: 'image', slot: { row: 0, column }, output_artifact_id: asset.value.artifactId },
      }))
      if (column === 0) sourceCellId = String(cell?.id ?? '')
    }
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      ...env,
      VIDEOBOOK_SERVER_URL: origin,
      VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache'),
      VIDEOBOOK_VITE_HMR: '0',
    })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.addInitScript((id) => {
      localStorage.setItem('videobook.active-book', id)
      localStorage.setItem('videobook.cloud-generation-consent', 'accepted')
    }, bookId)
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.postData()?.includes('edit_image_subjects')) {
        observed.push(...toolCalls(request.postDataJSON()).filter((entry) => entry.name === 'edit_image_subjects'))
      }
    })
    await page.goto(appUrl)
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    }
    await queue.stop()
    await books?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('explains H3 insertion with source and result tracks and prevents invalid timing', async () => {
    const book = books.get(bookId)
    if (!book.ok) throw new Error(book.error.message)
    const engine = book.value.engine
    const read = engine.notebooks.read(notebookId)
    if (!read.ok) throw new Error(read.error.message)
    const original = read.value
    const file = join(rootDir, 'insert-source.mp4')
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=9.04', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file])
    const asset = await engine.artifacts.create('video', 'Original clip')
    if (!asset.ok) throw new Error(asset.error.message)
    expect((await engine.files.writeFromPath(asset.value.artifactId, 'original.mp4', file)).ok).toBe(true)
    await engine.metadata.artifacts.write(asset.value.artifactId, 'original', { duration: 9.04, width: 320, height: 180, fps: 25, hasAudio: false })
    const poster = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#345a42' } }).jpeg().toBuffer()
    await engine.files.write(asset.value.artifactId, 'original.jpg', poster)
    const source = engine.notebooks.createCell({ type: 'video', slot: { row: 1, column: 0 }, outputArtifactId: asset.value.artifactId })
    const producer = engine.notebooks.createCell({
      type: 'generate_video', slot: { row: 1, column: 1 }, provider: 'fal', model: 'fal:minimax/h3-max/insert-video',
      operation: 'edit_video', tool: 'generate_video', prompt: 'The craftsman tries on the wooden shoes',
      inputs: { generationMode: 'default', generationSettings: { start_time: 14, resume_time: 6, duration: 13 } },
    })
    const written = await engine.notebooks.write({ ...original, cells: [...original.cells, source, producer], edges: [
      ...original.edges, engine.notebooks.createEdge({ source: source.id, target: producer.id, targetInput: 'video' }),
    ] })
    expect(written.ok).toBe(true)
    const requests: ObservedToolCall[] = []
    const observe = (request: Request) => {
      if (request.method() === 'POST' && request.url().endsWith('/mcp')) requests.push(...toolCalls(request.postDataJSON()))
    }
    page.on('request', observe)
    try {
      await page.reload()
      await page.locator(`.react-flow__node[data-id="${producer.id}"] .cell-node`).click()
      const editor = page.getByRole('region', { name: 'Insert scene timing' })
      await editor.waitFor({ state: 'visible' })
      const generate = page.getByRole('button', { name: /^Generate/ }).first()
      await expect.poll(() => editor.getByRole('alert').textContent()).toContain('source video ends at 9.04s')
      expect(await generate.isDisabled()).toBe(true)
      const start = editor.getByRole('spinbutton', { name: 'Replace from (seconds)' })
      const resume = editor.getByRole('spinbutton', { name: 'Resume original at (seconds)' })
      await start.fill('2')
      await expect.poll(() => editor.getByRole('status').textContent()).toContain('Result: 18.04s')
      expect(await editor.getByRole('img', { name: 'Original: keep 0 to 2s, replace 2 to 6s, keep 6 to 9.04s' }).count()).toBe(1)
      const openingWidths = await editor.locator('.insert-video-track .kept:first-child').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width))
      expect(Math.abs(openingWidths[0]! - openingWidths[1]!)).toBeLessThan(1)
      await expect.poll(() => generate.isEnabled()).toBe(true)
      const payload = page.getByLabel('Generation payload preview', { exact: true })
      await expect.poll(() => payload.textContent()).toContain('"start_time": 2')
      await editor.getByRole('slider', { name: 'Replace from slider' }).focus()
      await page.keyboard.press('ArrowRight')
      expect(await start.inputValue()).toBe('2.001')
      await start.fill('2')
      const video = editor.getByLabel('Original video for insert')
      await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
      await video.evaluate((node) => { (node as HTMLVideoElement).currentTime = 3 })
      await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime)).toBe(3)
      await editor.getByRole('button', { name: 'Replace from here' }).click()
      expect(await start.inputValue()).toBe('3')
      await resume.fill('2')
      await expect.poll(() => editor.getByRole('alert').textContent()).toContain('Resume original must be after')
      expect(await generate.isDisabled()).toBe(true)
      await resume.press('Control+Enter')
      expect(requests.filter((request) => request.name === 'run_notebook_cell')).toHaveLength(0)
      await resume.fill('6')
      await start.fill('2')
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        await editor.scrollIntoViewIfNeeded()
        const bounds = await editor.boundingBox()
        expect(bounds?.width).toBeLessThanOrEqual(width)
        expect(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        await page.screenshot({ path: `/tmp/videobook-insert-tracks-${width}.png` })
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await expect.poll(() => generate.isEnabled()).toBe(true)
      await generate.click()
      await expect.poll(() => requests.filter((request) => request.name === 'run_notebook_cell').length, { timeout: 15_000 }).toBe(1)
      const saved = engine.notebooks.read(notebookId)
      expect(saved.ok && saved.value.cells.find((cell) => cell.id === producer.id)?.inputs?.generationSettings)
        .toMatchObject({ start_time: 2, resume_time: 6, duration: 13 })
    } finally {
      page.off('request', observe)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await abortActiveBookJobsForTests()
      expect((await engine.notebooks.write(original)).ok).toBe(true)
      expect((await engine.artifacts.delete(asset.value.artifactId)).ok).toBe(true)
      await page.reload()
    }
  }, 60_000)

  it('retries only credit failures from the media tile without routing through chat', async () => {
    await pauseBookQueueForTests(bookId)
    const book = books.get(bookId)
    if (!book.ok) throw new Error(book.error.message)
    const engine = book.value.engine
    const previousRuns = engine.jobs.queue.list({ type: 'run_notebook' }).length
    const read = engine.notebooks.read(notebookId)
    if (!read.ok) throw new Error(read.error.message)
    const original = read.value
    const producer = engine.notebooks.createCell({
      type: 'generate_image', slot: { row: 1, column: 0 }, prompt: 'A carved wooden dragon',
      provider: 'kie', model: 'kie:nano-banana-2-1', tool: 'generate_image', operation: 'text_to_image',
    })
    let document = { ...original, cells: [...original.cells, producer] }
    const failures: NotebookCell[] = []
    for (const [column, message] of ['Insufficient credits', 'Invalid image size'].entries()) {
      const asset = await engine.artifacts.create('image', `Failure ${column}`)
      if (!asset.ok) throw new Error(asset.error.message)
      const lease = await engine.jobs.artifactWork.begin(asset.value.artifactId, {
        kind: 'generate', ownerKind: 'job', durationMs: 60_000,
      })
      if (!lease) throw new Error('Could not claim failed artifact')
      const taskId = `failed-image-${column}`
      const pending = await engine.jobs.pending.write({
        taskId, taskType: 'generate_media', artifactId: asset.value.artifactId, meta: {},
      }, lease.ownerId)
      if (!pending.ok) throw new Error(pending.error.message)
      await failPendingTaskAndLog(engine, asset.value.artifactId, taskId, { message })
      const output = engine.notebooks.createCell({
        type: 'image', slot: { row: 2, column }, outputArtifactId: asset.value.artifactId,
        inputs: { mediaRole: 'generate-image-output', producerCellId: producer.id, state: 'error' },
      })
      document = {
        ...document, cells: [...document.cells, output],
        edges: [...document.edges, engine.notebooks.createEdge({ source: producer.id, target: output.id, targetInput: 'media' })],
        execution: { ...document.execution, [output.id]: { fingerprint: 'failed', status: 'error', error: message, providerArtifactId: asset.value.artifactId } },
      }
      failures.push(output)
    }
    const written = await engine.notebooks.write(document)
    if (!written.ok) throw new Error(written.error.message)
    const requests: ObservedToolCall[] = []
    const observe = (request: Request) => {
      if (request.method() === 'POST' && request.url().endsWith('/mcp')) requests.push(...toolCalls(request.postDataJSON()))
    }
    page.on('request', observe)
    try {
      await page.reload()
      const failed = page.locator(`.react-flow__node[data-id="${failures[0]!.id}"]`)
      const other = page.locator(`.react-flow__node[data-id="${failures[1]!.id}"]`)
      const retry = failed.getByRole('button', { name: 'Retry @c1', exact: true })
      await retry.waitFor({ state: 'visible' })
      expect(await retry.textContent()).toContain('RETRY')
      expect(await failed.getByRole('button', { name: /Repair/ }).count()).toBe(0)
      expect(await other.getByRole('button', { name: /Retry/ }).count()).toBe(0)
      expect(await other.getByRole('button', { name: 'Repair @c2 in chat' }).count()).toBe(1)
      await expect.poll(() => retry.isEnabled()).toBe(true)
      await page.screenshot({ path: '/tmp/videobook-credit-retry-before.png' })
      await retry.click()
      await expect.poll(() => requests.some((request) => request.name === 'run_notebook_cell'), { timeout: 15_000 }).toBe(true)
      expect(requests.find((request) => request.name === 'run_notebook_cell')?.arguments).toMatchObject({
        cell_id: producer.id, retry_failed_cell_id: failures[0]!.id,
      })
      await expect.poll(() => failed.count(), { timeout: 15_000 }).toBe(0)
      const updated = engine.notebooks.read(notebookId)
      if (!updated.ok) throw new Error(updated.error.message)
      expect(updated.value.cells.find((cell) => cell.id === failures[1]!.id)).toMatchObject(failures[1]!)
      expect(updated.value.cells.find((cell) => cell.id === sourceCellId)?.outputArtifactId)
        .toBe(original.cells.find((cell) => cell.id === sourceCellId)?.outputArtifactId)
      const replacement = updated.value.cells.find((cell) => cell.slot.row === 2 && cell.slot.column === 0)!
      expect(replacement.id).not.toBe(failures[0]!.id)
      expect(updated.value.execution?.[replacement.id]?.status).toBe('queued')
      expect(requests.some((request) => request.name === 'chat')).toBe(false)
      expect(engine.jobs.queue.list({ type: 'run_notebook' })).toHaveLength(previousRuns + 1)
      await page.screenshot({ path: '/tmp/videobook-credit-retry-after.png' })
    } finally {
      page.off('request', observe)
      await abortActiveBookJobsForTests()
      const restored = await engine.notebooks.write(original)
      expect(restored.ok).toBe(true)
      await page.reload()
    }
  }, 60_000)

  it('routes prompt edits, removal and replacement to the drawn selection without subject analysis', async () => {
    await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
    await page.getByRole('button', { name: 'Edit @a1 image', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Fullscreen preview for @a1' })
    const instruction = dialog.getByLabel('What should change?')
    await expect.poll(() => dialog.getByLabel('Model', { exact: true }).inputValue()).toBe('nano-banana-2-1')
    const draw = dialog.getByRole('button', { name: 'Draw region', exact: true })
    const drawRegion = async (left: number, top: number, width: number, height: number) => {
      await draw.click()
      const image = await dialog.locator('.notebook-subject-stage-svg > image').boundingBox()
      if (!image) throw new Error('Image stage is missing')
      await page.mouse.move(image.x + image.width * left, image.y + image.height * top)
      await page.mouse.down()
      await page.mouse.move(image.x + image.width * (left + width), image.y + image.height * (top + height), { steps: 5 })
      await page.mouse.up()
      await draw.click()
    }
    const rejectedByProviderConfig = async () => {
      await expect.poll(() => dialog.locator('.image-editor-status.error').textContent())
        .toContain('KIE_API_KEY environment variable is not set')
    }
    await drawRegion(0.1, 0.1, 0.3, 0.4)
    expect(await dialog.getByRole('checkbox', { name: 'Select region 1', exact: true }).isChecked()).toBe(true)
    expect(await dialog.locator('.image-editor-target strong').textContent()).toBe('Region 1')
    await instruction.fill('Remove the glass door but keep the person')
    await dialog.getByRole('button', { name: /Apply edit/ }).click()
    await rejectedByProviderConfig()
    expect(observed[0]?.arguments).toMatchObject({
      operation: 'edit', prompt: 'Remove the glass door but keep the person',
      edit_regions: [{ x: expect.closeTo(0.1, 2), y: expect.closeTo(0.1, 2), width: expect.closeTo(0.3, 2), height: expect.closeTo(0.4, 2) }],
    })
    expect(observed[0]?.arguments).not.toHaveProperty('regions')
    expect(await instruction.inputValue()).toBe('Remove the glass door but keep the person')

    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await rejectedByProviderConfig()
    expect(observed[1]?.arguments).toMatchObject({
      operation: 'remove', edit_regions: observed[0]!.arguments.edit_regions,
      model: 'nano-banana-2-1',
    })
    await dialog.getByLabel('Model', { exact: true }).selectOption('seedream/5-pro-image-to-image')
    await instruction.fill('')
    await dialog.getByRole('listbox', { name: 'Replacement for Region 1' })
      .getByRole('option', { name: '@a2', exact: true }).click()
    await dialog.getByRole('button', { name: /Replace with image/ }).click()
    await rejectedByProviderConfig()
    expect(observed[2]?.arguments).toMatchObject({
      operation: 'replace', regions: [{ box: (observed[0]!.arguments.edit_regions as unknown[])[0], replacement_artifact_id: expect.any(String) }],
      model: 'seedream/5-pro-image-to-image',
    })
    expect(observed[2]?.arguments).not.toHaveProperty('edit_regions')
    await dialog.getByRole('button', { name: 'Clear replacement for Region 1' }).click()
    expect(await dialog.getByRole('button', { name: /Apply edit/ }).isVisible()).toBe(true)

    await drawRegion(0.6, 0.5, 0.2, 0.3)
    await dialog.getByRole('checkbox', { name: 'Select region 1', exact: true }).uncheck()
    expect(await dialog.locator('.image-editor-target strong').textContent()).toBe('Region 2')
    await instruction.fill('Make this area blue')
    await instruction.press('Control+Enter')
    await rejectedByProviderConfig()
    expect(observed[3]?.arguments).toMatchObject({
      operation: 'edit',
      edit_regions: [{ x: expect.closeTo(0.6, 2), y: expect.closeTo(0.5, 2), width: expect.closeTo(0.2, 2), height: expect.closeTo(0.3, 2) }],
    })
    await page.screenshot({ path: '/tmp/videobook-region-editor-check.png' })
  }, 60_000)

  it('draws regions with touch and clears interrupted gestures on a phone', async () => {
    const phone = await browser!.newPage({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    })
    const requests: ObservedToolCall[] = []
    try {
      await phone.addInitScript((id) => {
        localStorage.setItem('videobook.active-book', id)
        localStorage.setItem('videobook.cloud-generation-consent', 'accepted')
      }, bookId)
      phone.on('request', (request) => {
        if (request.method() === 'POST' && request.postData()?.includes('edit_image_subjects')) {
          requests.push(...toolCalls(request.postDataJSON()).filter((entry) => entry.name === 'edit_image_subjects'))
        }
      })
      await phone.goto(page.url())
      await phone.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).tap()
      await phone.getByRole('button', { name: 'Edit @a1 image', exact: true }).tap()
      const dialog = phone.getByRole('dialog', { name: 'Fullscreen preview for @a1' })
      await dialog.getByRole('button', { name: 'Draw region', exact: true }).tap()
      const touch = await phone.context().newCDPSession(phone)
      const drag = async (cancel: boolean) => {
        const image = await dialog.locator('.notebook-subject-stage-svg > image').boundingBox()
        if (!image) throw new Error('Image stage is missing')
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: image.x + image.width * 0.1, y: image.y + image.height * 0.1 }],
        })
        for (let step = 1; step <= 5; step += 1) {
          await touch.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{
              x: image.x + image.width * (0.1 + step * 0.1),
              y: image.y + image.height * (0.1 + step * 0.12),
            }],
          })
        }
        await touch.send('Input.dispatchTouchEvent', {
          type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [],
        })
      }
      await drag(true)
      expect(await dialog.getByRole('checkbox', { name: 'Select region 1', exact: true }).count()).toBe(0)
      await expect.poll(() => dialog.locator('.notebook-region-draft').count()).toBe(0)
      await drag(false)
      await expect.poll(() => dialog.getByRole('checkbox', { name: 'Select region 1', exact: true }).count()).toBe(1)
      expect(await dialog.getByRole('checkbox', { name: 'Select region 1', exact: true }).isChecked()).toBe(true)
      expect(await dialog.locator('.image-editor-target strong').textContent()).toBe('Region 1')
      await dialog.getByLabel('What should change?').fill('Make this area blue')
      await dialog.getByRole('button', { name: /Apply edit/ }).tap()
      await expect.poll(() => requests.length).toBe(1)
      expect(requests[0]?.arguments).toMatchObject({
        operation: 'edit', prompt: 'Make this area blue',
        edit_regions: [{ x: expect.closeTo(0.1, 2), y: expect.closeTo(0.1, 2), width: expect.closeTo(0.5, 2), height: expect.closeTo(0.6, 2) }],
      })
      await expect.poll(() => dialog.locator('.image-editor-status.error').textContent())
        .toContain('KIE_API_KEY environment variable is not set')
      await touch.detach()
    } finally {
      await phone.close()
    }
  }, 60_000)

  it('remembers instructions across reopening and reload, then reveals the queued generation', async () => {
    const prompt = 'Match the light and preserve the surrounding trees'
    await page.reload()
    await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
    const edit = page.getByRole('button', { name: 'Edit @a1 image', exact: true })
    await edit.click()
    const dialog = page.getByRole('dialog', { name: 'Fullscreen preview for @a1' })
    const instruction = dialog.getByLabel('What should change?')
    await instruction.fill(prompt)
    await instruction.press('Escape')
    await dialog.getByRole('button', { name: 'Edit image', exact: true }).click()
    expect(await instruction.inputValue()).toBe(prompt)
    await dialog.getByRole('button', { name: 'Close fullscreen preview' }).click()
    await edit.click()
    expect(await instruction.inputValue()).toBe(prompt)
    await page.reload()
    await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
    await edit.click()
    expect(await instruction.inputValue()).toBe(prompt)
    await dialog.getByRole('button', { name: 'Close fullscreen preview' }).click()

    await call('move_notebook_cells', { slots: [{ id: sourceCellId, row: 12, column: 0 }] })
    await page.reload()
    await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
    await page.getByRole('button', { name: 'Edit @m1 image', exact: true }).click()
    const movedDialog = page.getByRole('dialog', { name: 'Fullscreen preview for @m1' })
    await expect.poll(() => movedDialog.getByLabel('Model', { exact: true }).inputValue()).toBe('nano-banana-2-1')
    expect(await movedDialog.getByLabel('What should change?').inputValue()).toBe(prompt)
    await movedDialog.getByRole('button', { name: 'Draw region', exact: true }).click()
    const image = await movedDialog.locator('.notebook-subject-stage-svg > image').boundingBox()
    if (!image) throw new Error('Missing image stage')
    await page.mouse.move(image.x + image.width * 0.1, image.y + image.height * 0.1)
    await page.mouse.down()
    await page.mouse.move(image.x + image.width * 0.5, image.y + image.height * 0.5, { steps: 5 })
    await page.mouse.up()
    await movedDialog.getByRole('listbox', { name: 'Replacement for Region 1' })
      .getByRole('option', { name: '@a2', exact: true }).click()
    await page.locator('.notebook-horizontal-scroll').evaluate((node) => { node.scrollTop = 0 })
    const originalKey = process.env.KIE_API_KEY
    process.env.KIE_API_KEY = 'test-key'
    try {
      await movedDialog.getByRole('button', { name: /Replace with image/ }).click()
      await movedDialog.waitFor({ state: 'hidden', timeout: 15_000 })
      const notebook = record(await call('get_notebook'))
      const cells = (Array.isArray(notebook?.cells) ? notebook.cells : []).map(record)
      const producer = cells.find((cell) => cell?.type === 'generate_image')
      expect(producer?.prompt).toContain(prompt)
      const generation = page.locator(`.react-flow__node[data-id="${String(producer?.id)}"]`)
      await expect.poll(() => generation.getAttribute('class')).toContain('selected')
      expect(await page.locator('.react-flow__node.selected').count()).toBe(1)
      await expect.poll(() => generation.evaluate((node) => {
        const bounds = node.getBoundingClientRect()
        const scroll = document.querySelector('.notebook-horizontal-scroll')
        const composer = document.querySelector('.command-composer')
        if (!scroll || !composer) return false
        return bounds.top >= scroll.getBoundingClientRect().top
          && bounds.bottom <= composer.getBoundingClientRect().top + 2
      })).toBe(true)
      expect(await page.locator('.app-shell').evaluate((node) => (node as HTMLElement).inert)).toBe(false)
      expect(await page.locator('.command-composer').getAttribute('data-dock-open')).toBe('false')
      expect(await page.locator('.command-composer-dock-body').isVisible()).toBe(false)
      expect(await page.getByLabel('Videobook command input').isVisible()).toBe(true)
      await page.screenshot({ path: '/tmp/videobook-region-generation-focus.png' })
      await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
      await page.getByRole('button', { name: 'Edit @m1 image', exact: true }).click()
      expect(await movedDialog.getByLabel('What should change?').inputValue()).toBe(prompt)
      await movedDialog.getByLabel('What should change?').fill('')
      await page.reload()
      await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
      await page.getByRole('button', { name: 'Edit @m1 image', exact: true }).click()
      expect(await movedDialog.getByLabel('What should change?').inputValue()).toBe('')
    } finally {
      if (originalKey === undefined) delete process.env.KIE_API_KEY
      else process.env.KIE_API_KEY = originalKey
      await abortActiveBookJobsForTests()
    }
  }, 60_000)

  it('reopens an image edit with its model and editable prompt, keeping provider links on the failed output', async () => {
    await pauseBookQueueForTests(bookId)
    const book = books.get(bookId)
    if (!book.ok) throw new Error(book.error.message)
    const engine = book.value.engine
    const document = engine.notebooks.read(notebookId)
    if (!document.ok) throw new Error(document.error.message)
    const cell = document.value.cells.find((candidate) => candidate.id === sourceCellId)!
    const source = await resolveImageSubjectSource(engine, cell.outputArtifactId!)
    const originalKey = process.env.FAL_API_KEY
    process.env.FAL_API_KEY = 'test-key'
    try {
      const edited = record(await call('edit_image_subjects', {
        source_cell_id: sourceCellId, artifact_id: source.artifactId,
        object_hash: source.objectHash, operation: 'whole_image',
        prompt: 'A portal behind the person', model: 'fal-ai/nano-banana-pro/edit',
      }))!
      const artifactId = String(edited.output_artifact_id)
      const providerTaskId = 'fal-browser-status-request'
      await engine.metadata.artifacts.write(artifactId, 'generation-payload', {
        endpoint_id: 'fal-ai/nano-banana-pro/edit', input: { prompt: 'A portal behind the person' },
      })
      await engine.metadata.artifacts.write(artifactId, 'kie-task-id', { taskId: providerTaskId })
      const job = engine.jobs.queue.list({ type: 'generate_image_subject_edit' })
        .find((candidate) => candidate.payload.imageAssetId === artifactId)!
      await engine.jobs.queue.abort(job.id, 'Provider rejected this request')
      await reconcileImageSubjectJobFailures(engine, bookId)
      await page.reload()
      await page.locator(`.react-flow__node[data-id="${String(edited.producer_cell_id)}"] .cell-node`).click()
      const editor = page.locator('.generation-cell-inspector .confirm-generation')
      await expect.poll(() => editor.getByLabel('Generation model').inputValue()).toBe('image-edit.fal-ai/nano-banana-pro/edit')
      const payload = editor.locator('.generation-review-json pre')
      await expect.poll(() => payload.textContent(), { timeout: 15_000 }).toContain('"endpoint_id": "fal-ai/nano-banana-pro/edit"')
      expect(await page.getByText('This model does not accept the current inputs.', { exact: false }).count()).toBe(0)
      await editor.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A spider portal behind the person')
      await expect.poll(() => payload.textContent(), { timeout: 15_000 }).toContain('A spider portal behind the person')
      expect(await editor.getByRole('link', { name: 'fal requests' }).count()).toBe(0)
      await editor.getByLabel('Generation model').selectOption('image-edit.seedream/5-pro-image-to-image')
      await expect.poll(() => payload.textContent(), { timeout: 15_000 }).toContain('seedream/5-pro-image-to-image')
      expect(await editor.getByRole('link', { name: 'Kie logs' }).count()).toBe(0)
      await editor.getByLabel('Generation model').selectOption('image-edit.fal-ai/nano-banana-pro/edit')
      await expect.poll(() => payload.textContent(), { timeout: 15_000 }).toContain('fal-ai/nano-banana-pro/edit')
      await page.screenshot({ path: '/tmp/videobook-image-edit-inspector.png' })
      const generate = page.getByLabel('Primary cell action').getByRole('button', { name: 'Generate', exact: true })
      await expect.poll(() => generate.isEnabled(), { timeout: 15_000 }).toBe(true)
      await generate.click()
      await expect.poll(() => page.locator('.command-composer').getAttribute('data-dock-open'), { timeout: 15_000 }).toBe('false')
      const updated = engine.notebooks.read(notebookId)
      if (!updated.ok) throw new Error(updated.error.message)
      const producer = updated.value.cells.find((candidate) => candidate.id === edited.producer_cell_id)!
      expect(producer.prompt).toBe('A spider portal behind the person')
      expect(producer.inputs).toMatchObject({ generationMode: 'whole-image', sourceObjectHash: source.objectHash })
      expect(updated.value.cells.filter((candidate) => candidate.inputs?.producerCellId === producer.id)).toHaveLength(2)
      await page.locator(`.react-flow__node[data-id="${String(edited.output_cell_id)}"] .cell-node`).click()
      const failedOutput = page.locator('.inspector-media-generating[data-generation="failed"]')
      const failedLink = failedOutput.getByRole('link', { name: 'fal requests' })
      await failedLink.waitFor({ state: 'visible' })
      expect(await failedLink.getAttribute('href')).toBe('https://fal.ai/models/fal-ai/nano-banana-pro/edit/requests')
      expect(await failedLink.getAttribute('target')).toBe('_blank')
      expect(await failedLink.getAttribute('rel')).toContain('noopener')
      expect(await failedOutput.locator('.provider-task-link').textContent()).toContain(providerTaskId)
      await page.screenshot({ path: '/tmp/videobook-failed-output-status-link.png' })
      await page.getByLabel('Open Jobs').click()
      const jobRow = page.locator('.jobs-row').filter({ hasText: providerTaskId })
      await jobRow.waitFor({ state: 'visible' })
      expect(await jobRow.getByRole('link', { name: 'fal requests' }).getAttribute('target')).toBe('_blank')
      expect(await jobRow.getByLabel('Copy provider request ID').isVisible()).toBe(true)
      await page.screenshot({ path: '/tmp/videobook-provider-job-link.png' })
    } finally {
      if (originalKey === undefined) delete process.env.FAL_API_KEY
      else process.env.FAL_API_KEY = originalKey
      await abortActiveBookJobsForTests()
      await page.goto(new URL('/', page.url()).toString())
    }
  }, 60_000)

  it('keeps Seedance frame controls and previews adaptive while preserving text and reference ratios', async () => {
    for (const [index, mode] of ['first', 'pair', 'text', 'reference'].entries()) {
      const frames = mode === 'first' || mode === 'pair'
      const created = record(await call('create_notebook_cell', {
        cell: {
          type: 'generate_video', slot: { row: 22, column: index }, prompt: 'Pan across the garden',
          provider: 'kie', model: 'kie:bytedance/seedance-2-5', tool: 'generate_video',
          inputs: {
            generationMode: frames ? 'i2v' : mode === 'reference' ? 'r2v' : 't2v',
            generationSettings: { aspect_ratio: '9:16', duration: 10 },
          },
        },
      }))
      const cellId = String(created?.id ?? '')
      if (mode !== 'text') {
        await call('connect_notebook_cells', {
          source_cell_id: sourceCellId, target_cell_id: cellId, target_input: frames ? 'first_frame' : 'image',
        })
      }
      if (mode === 'pair') {
        await call('connect_notebook_cells', {
          source_cell_id: sourceCellId, target_cell_id: cellId, target_input: 'last_frame',
        })
      }
      await page.reload()
      const node = page.locator(`.react-flow__node[data-id="${cellId}"] .cell-node`)
      await node.click()
      const editor = page.locator('.generation-cell-inspector .confirm-generation')
      const aspect = editor.getByLabel('Aspect ratio', { exact: true })
      await aspect.waitFor({ state: 'visible' })
      expect(await aspect.inputValue()).toBe(frames ? 'string:adaptive' : 'string:9:16')
      expect(await aspect.isDisabled()).toBe(frames)
      expect(await node.textContent()).toContain(frames ? 'adaptive' : '9:16')
      const source = editor.locator('.generation-review-json pre')
      await expect.poll(() => source.textContent(), { timeout: 15_000 })
        .toContain(`"aspect_ratio": "${frames ? 'adaptive' : '9:16'}"`)
      if (frames) {
        expect(await editor.getByText('Frame mode follows the first image’s aspect ratio (adaptive).', { exact: true }).isVisible()).toBe(true)
        expect(await source.textContent()).toContain('"first_frame_url"')
        if (mode === 'pair') expect(await source.textContent()).toContain('"last_frame_url"')
      } else {
        await aspect.selectOption('string:16:9')
        await expect.poll(() => source.textContent(), { timeout: 15_000 }).toContain('"aspect_ratio": "16:9"')
      }
    }
    await page.screenshot({ path: '/tmp/videobook-seedance-aspect-controls.png' })
  }, 60_000)

  it('collapses previews and history when image generation is queued, then allows manual reopening', async () => {
    const created = record(await call('create_notebook_cell', {
      cell: { type: 'generate_image', slot: { row: 20, column: 0 }, prompt: 'A green garden in daylight' },
    }))
    const cellId = String(created?.id ?? '')
    await page.reload()
    const generation = page.locator(`.react-flow__node[data-id="${cellId}"] .cell-node`)
    await generation.click()
    const composer = page.locator('.command-composer')
    const input = page.getByLabel('Videobook command input')
    expect(await composer.getAttribute('data-dock-open')).toBe('true')
    await input.fill('Keep my next prompt')
    const originalKey = process.env.KIE_API_KEY
    process.env.KIE_API_KEY = 'test-key'
    try {
      const generate = page.getByLabel('Primary cell action').getByRole('button', { name: 'Generate', exact: true })
      await expect.poll(() => generate.isEnabled(), { timeout: 15_000 }).toBe(true)
      await generate.click()
      await expect.poll(() => composer.getAttribute('data-dock-open'), { timeout: 15_000 }).toBe('false')
      expect(await composer.locator('.command-composer-dock-body').isVisible()).toBe(false)
      expect(await input.textContent()).toBe('Keep my next prompt')
      const notebook = record(await call('get_notebook'))
      const cells = (Array.isArray(notebook?.cells) ? notebook.cells : []).map(record)
      expect(cells.some((cell) => cell?.type === 'image' && record(cell.inputs)?.producerCellId === cellId)).toBe(true)
      await generation.click()
      expect(await composer.getAttribute('data-dock-open')).toBe('true')
      const refreshed = page.waitForResponse((response) => response.request().method() === 'POST'
        && (response.request().postData() ?? '').includes('get_notebook'))
      await refreshed
      expect(await composer.getAttribute('data-dock-open')).toBe('true')
      expect(await input.textContent()).toBe('Keep my next prompt')
    } finally {
      if (originalKey === undefined) delete process.env.KIE_API_KEY
      else process.env.KIE_API_KEY = originalKey
      await abortActiveBookJobsForTests()
    }
  }, 60_000)
})
