import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import express from 'express'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import type { Engine } from 'videobook-engine'
import { afterAll, describe, expect, it, beforeAll } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine } from '../../server/src/book-context.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { parseHttpByteRange } from '../../server/src/http-byte-range.js'
import { registerAllJobHandlers } from '../../server/src/jobs/index.js'
import { configureProviderEndpoints } from '../../server/src/media/endpoints.js'
import { registerMediaProbe } from '../../server/src/notebook-media-ops.js'
import { queue, setEngineRoot, stopBookQueue } from '../../server/src/queue.js'
import { createHttpHandler } from '../../server/src/server.js'
import { testBudget } from '../../server/src/test-budget.js'
import { extractVideoPoster } from '../../server/src/video-poster.js'
import { availablePort, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

const exec = promisify(execFile)

type NotebookWire = {
  cells: Array<{
    id: string
    output_artifact_id?: string
    slot: { row: number; column: number }
    inputs?: { outputVersionArtifactIds?: string[] }
  }>
}

function responsesPayload(text: string) {
  return {
    id: 'resp_auto_edit_e2e',
    object: 'response',
    status: 'completed',
    output: [{
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    }],
    usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
  }
}

describe('auto-edit review sheet in the browser', () => {
  let root = ''
  let server: Server | undefined
  let stubServer: Server | undefined
  let restoreEndpoints: (() => void) | undefined
  let vite: StartedProcess | undefined
  let browser: Browser | undefined
  let client: Client | undefined
  let page: Page
  let books: BookManager
  let engine: Engine
  let bookId = ''
  let notebookId = ''
  let sourceId = ''
  let sourceCellId = ''
  let appUrl = ''
  const calls: string[] = []
  const errors: string[] = []
  const stubRequests: Array<{ kind: 'analysis' | 'chat'; queryOrPrompt: string }> = []
  const previousOpenAi = process.env.OPENAI_API_KEY

  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(
    await client!.callTool({ name, arguments: { book_id: bookId, ...args } }),
  ) as T

  const sheet = () => page.getByRole('dialog', { name: 'Auto-edit review', exact: true })
  const marker = (anchor: string) => sheet().locator(`.auto-edit-marker[data-anchor="${anchor}"]`)

  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: testBudget(30_000) }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
  }

  beforeAll(async () => {
    delete process.env.OPENAI_API_KEY
    root = await mkdtemp(join(tmpdir(), 'videobook-auto-edit-ui-'))
    const fixture = join(root, 'source.mp4')
    await exec(FFMPEG, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=24:duration=9',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture,
    ])

    stubServer = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          instructions?: string
          input?: unknown
          text?: { format?: { type?: string; name?: string } }
        }
        const isAnalysis = body.text?.format?.type === 'json_schema' && body.text?.format?.name === 'auto_edit_moments'
        if (isAnalysis) {
          stubRequests.push({ kind: 'analysis', queryOrPrompt: String(body.instructions ?? '') })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(responsesPayload(JSON.stringify({
            hook: { start: 0.6, end: 2.8 },
            moment: { start: 5.0, peak: 5.5, end: 6.2 },
            focus: {
              start: { x: 0.3, y: 0.4 },
              peak: { x: 0.7, y: 0.5 },
              end: { x: 0.6, y: 0.5 },
            },
            keep: { start: 0.3, end: 8.5 },
            cuts: [{ start: 3.4, end: 3.9, reason: 'Nothing happens.' }],
            summary: 'Stubbed sofa leap highlight.',
            confidence: 'high',
          }))))
          return
        }
        const userText = Array.isArray(body.input) ? JSON.stringify(body.input) : String(body.input ?? '')
        stubRequests.push({ kind: 'chat', queryOrPrompt: `${body.instructions ?? ''}\n${userText}` })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(responsesPayload(JSON.stringify({
          tool: 'show_auto_edit',
          params: { asset_id: sourceId },
          message: 'Opening auto-edit.',
        }))))
      })
    })
    await new Promise<void>((resolve) => stubServer!.listen(0, '127.0.0.1', resolve))
    const stubAddress = stubServer.address() as AddressInfo
    restoreEndpoints = configureProviderEndpoints({
      openaiBaseURL: `http://127.0.0.1:${stubAddress.port}`,
    })

    books = new BookManager({ libraryDir: join(root, 'books') })
    await books.ready()
    const created = await books.create('auto-edit-ui')
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const found = books.get(bookId)
    if (!found.ok) throw new Error(found.error.message)
    engine = found.value.engine
    registerAllJobHandlers(engine)
    await setEngineRoot(found.value.rootDir, engine)

    const source = await engine.artifacts.create({ kind: 'video', label: 'Original leap' })
    if (!source.ok) throw new Error(source.error.message)
    sourceId = source.value.artifactId
    await engine.files.writeFromPath(sourceId, 'original.mp4', fixture)
    await registerMediaProbe(engine, sourceId, 'original.mp4', await probeVideo(fixture))
    await engine.files.write(sourceId, 'original.jpg', await extractVideoPoster(fixture, 9))
    const notebook = engine.notebooks.list()[0]!
    notebookId = notebook.id
    const cell = engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 0 }, outputArtifactId: sourceId })
    sourceCellId = cell.id
    await engine.notebooks.insertCell(notebook.id, cell)

    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    const handler = toNodeHandler(createHttpHandler(scopedBookEngine, books))
    const app = express()
    app.use(express.json({ limit: '4mb' }))
    app.all('/mcp', (request, response) => { void handler(request, response, request.body) })
    app.get('/healthz', (_request, response) => { response.status(200).json({ ok: true }) })
    app.get(/^\/files\/([^/]+)\/([^/]+)\/(.+)$/, async (request, response) => {
      const book = books.get(String(request.params[0]))
      if (!book.ok) { response.sendStatus(404); return }
      const file = await book.value.engine.files.read(String(request.params[1]), String(request.params[2]))
      if (!file.ok) { response.sendStatus(404); return }
      const data = file.value
      const rangeHeader = request.headers.range
      response.type(String(request.params[2]))
      response.setHeader('Accept-Ranges', 'bytes')
      if (typeof rangeHeader === 'string') {
        const parsed = parseHttpByteRange(rangeHeader, data.length)
        if (!parsed.ok) { response.sendStatus(416); return }
        const slice = data.subarray(parsed.start, parsed.end + 1)
        response.status(206)
        response.setHeader('Content-Range', `bytes ${parsed.start}-${parsed.end}/${data.length}`)
        response.setHeader('Content-Length', String(slice.length))
        response.send(slice)
        return
      }
      response.setHeader('Content-Length', String(data.length))
      response.send(data)
    })
    server = createServer(app)
    await new Promise<void>((resolve) => server!.listen(port, '127.0.0.1', resolve))

    client = new Client(
      { name: 'auto-edit-ui', version: '1' },
      { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } },
    )
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))

    const vitePort = await availablePort()
    appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(
      ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
      { ...process.env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' },
    )
    await waitForHttp(appUrl, vite, 200)

    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(testBudget(12_000))
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (request.method() !== 'POST' || !request.url().endsWith('/mcp')) return
      calls.push(...toolCalls(request.postDataJSON()).map((item) => item.name))
    })
    await page.addInitScript((id) => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
  }, testBudget(60_000))

  afterAll(async () => {
    restoreEndpoints?.()
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAi
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    if (stubServer) await new Promise<void>((resolve) => stubServer!.close(() => resolve()))
    await stopBookQueue(bookId).catch(() => undefined)
    await queue.stop()
    await books?.close()
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }, testBudget(30_000))

  it('edits without a key, preserves Escape drafts, previews segments/looks, renders versions, and analyzes once with a key', async () => {
    await command('/auto-edit @a1')
    await sheet().waitFor({ state: 'visible' })
    const findButton = sheet().getByRole('button', { name: 'Find the moment', exact: true })
    await expect.poll(() => findButton.isDisabled()).toBe(true)
    expect(await sheet().textContent()).toContain('OPENAI_API_KEY')

    const stageBox = async () => await sheet().locator('.auto-edit-stage').boundingBox()
    await expect.poll(async () => {
      const box = await stageBox()
      return box ? Math.max(box.width, box.height) : 0
    }).toBeGreaterThan(300)

    const segmentNames = () => sheet().locator('.auto-edit-segment-name').allInnerTexts()
    await expect.poll(segmentNames).toEqual(['Cold open', 'Body', 'Replay', 'Punch-in', 'Push-in', 'Crash', 'Ending'])

    const editLength = () => sheet().locator('.auto-edit-lane-label strong').first().innerText()
    const fullLength = await editLength()
    const coldSwitch = sheet().getByRole('switch', { name: 'Cold open', exact: true })
    const crashSwitch = sheet().getByRole('switch', { name: 'Crash', exact: true })
    await coldSwitch.uncheck()
    expect(await segmentNames()).toEqual(['Body', 'Replay', 'Punch-in', 'Push-in', 'Crash', 'Ending'])
    expect(await editLength()).not.toBe(fullLength)
    await coldSwitch.check()
    await crashSwitch.uncheck()
    expect(await segmentNames()).toEqual(['Cold open', 'Body', 'Replay', 'Punch-in', 'Push-in', 'Ending'])
    await crashSwitch.check()

    const hookStartMarker = marker('hook.start')
    await hookStartMarker.click()
    const hookStartGroup = sheet().getByRole('group', { name: 'Hook start', exact: true })
    const hookTextBefore = await hookStartGroup.textContent()
    const beforeFrameMatch = hookTextBefore?.match(/frame (\d+)/)
    expect(beforeFrameMatch).not.toBeNull()
    const beforeFrame = Number(beforeFrameMatch![1])
    await hookStartGroup.getByRole('button', { name: '+1 frame', exact: true }).click()
    await expect.poll(() => hookStartGroup.textContent()).toContain(`frame ${beforeFrame + 1}`)
    await hookStartGroup.getByRole('button', { name: '-1 frame', exact: true }).click()
    await expect.poll(() => hookStartGroup.textContent()).toContain(`frame ${beforeFrame}`)
    await marker('hook.start').focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => hookStartGroup.textContent()).toContain(`frame ${beforeFrame + 1}`)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => hookStartGroup.textContent()).toContain(`frame ${beforeFrame}`)

    const editBefore = await editLength()
    const bodyStartBefore = await marker('keep.start').getAttribute('aria-label')
    await marker('keep.start').click()
    const bodyStartGroup = sheet().getByRole('group', { name: 'Body start', exact: true })
    await bodyStartGroup.getByRole('button', { name: '+1 frame', exact: true }).click()
    await expect.poll(editLength).not.toBe(editBefore)
    await expect.poll(() => marker('keep.start').getAttribute('aria-label')).not.toBe(bodyStartBefore)
    await bodyStartGroup.getByRole('button', { name: '-1 frame', exact: true }).click()
    await expect.poll(() => marker('keep.start').getAttribute('aria-label')).toBe(bodyStartBefore)

    const video = sheet().getByLabel('Auto-edit preview', { exact: true })
    const pauseButton = sheet().getByRole('button', { name: 'Pause', exact: true })
    if (await pauseButton.isVisible()) await pauseButton.click()

    const peakMarker = marker('moment.peak')
    await peakMarker.click()
    expect(await sheet().getByRole('button', { name: 'Source', exact: true }).getAttribute('aria-pressed')).toBe('true')
    const peakSeconds = Number((await peakMarker.getAttribute('aria-label'))!.match(/([\d.]+)s$/)![1])
    const sourceDuration = await video.evaluate((el: HTMLVideoElement) => el.duration)
    await expect.poll(async () => Number.parseFloat(await sheet().locator('.auto-edit-playhead-source').evaluate((el: HTMLElement) => el.style.left)))
      .toBeCloseTo((peakSeconds / sourceDuration) * 100, 0)
    const peakGroup = sheet().getByRole('group', { name: 'Moment peak', exact: true })
    const box = await stageBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width * 0.25, box!.y + box!.height * 0.75)
    await expect.poll(() => peakGroup.textContent()).toContain('25% across, 75% down')

    const markerSeconds = async (anchor: string) => Number((await marker(anchor).getAttribute('aria-label'))!.match(/([\d.]+)s$/)![1])
    const endBefore = await markerSeconds('moment.end')
    const endBox = (await marker('moment.end').boundingBox())!
    await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(endBox.x + endBox.width / 2 + 15, endBox.y + endBox.height / 2, { steps: 3 })
    await page.mouse.move(endBox.x + endBox.width / 2 + 30, endBox.y + endBox.height / 2, { steps: 3 })
    await page.mouse.up()
    await expect.poll(() => markerSeconds('moment.end')).toBeGreaterThan(endBefore)
    expect(await marker('moment.end').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => sheet().getByRole('group', { name: 'Moment end', exact: true }).textContent()).toContain(`${(await markerSeconds('moment.end')).toFixed(2)}s`)

    await hookStartMarker.click()
    await hookStartGroup.getByRole('button', { name: 'Move to playhead', exact: true }).click()

    const hookRenderBtn = sheet().getByRole('button', { name: /^Render/ })
    await hookRenderBtn.focus()
    await page.keyboard.press('Tab')
    const afterRenderFocus = await sheet().evaluate((el) => ({
      inside: el.contains(document.activeElement),
      tag: document.activeElement?.tagName ?? '',
      text: (document.activeElement?.textContent ?? '').trim(),
    }))
    expect(afterRenderFocus.inside).toBe(true)
    expect(afterRenderFocus.text).toContain('Cancel')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    const bodyTabFocus = await sheet().evaluate((el) => ({
      inside: el.contains(document.activeElement),
      tag: document.activeElement?.tagName ?? '',
    }))
    expect(bodyTabFocus.inside).toBe(true)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => sheet().evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const renderBtn = sheet().getByRole('button', { name: /^Render/ })
    const cancelBtn = sheet().getByRole('button', { name: /^Cancel/ })
    const renderBox = await renderBtn.boundingBox()
    const cancelBox = await cancelBtn.boundingBox()
    expect(renderBox && cancelBox).toBeTruthy()
    expect(renderBox!.x + renderBox!.width <= cancelBox!.x + 1 || renderBox!.y + renderBox!.height <= cancelBox!.y + 1).toBe(true)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect.poll(() => sheet().evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)

    await crashSwitch.uncheck()
    await crashSwitch.focus()
    await page.keyboard.press('Escape')
    await sheet().waitFor({ state: 'hidden' })
    expect(await page.getByLabel('Videobook command input', { exact: true }).evaluate((el) => document.activeElement === el)).toBe(true)
    expect((await call<NotebookWire>('get_notebook', { notebook_id: notebookId })).cells).toHaveLength(1)

    const sourceNode = page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`)
    await sourceNode.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Auto-edit', exact: true }).click()
    await sheet().waitFor({ state: 'visible' })
    expect(await crashSwitch.isChecked()).toBe(false)
    await marker('moment.peak').click()
    expect(await peakGroup.textContent()).toContain('25% across, 75% down')
    await crashSwitch.check()

    await sheet().getByRole('button', { name: /^Cold open / }).click()
    expect(await sheet().getByRole('button', { name: 'Edit', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.dataset.segmentId)).toBe('cold-open')
    await sheet().getByRole('button', { name: /^Crash / }).click()
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => ({
      segment: el.dataset.segmentId,
      rate: el.playbackRate,
      look: el.dataset.look,
      filter: el.style.filter,
    })), { timeout: testBudget(10_000) }).toMatchObject({
      segment: 'crash',
      rate: 0.5,
      look: 'crash',
    })
    const filterValue = await video.evaluate((el: HTMLVideoElement) => el.style.filter)
    expect(filterValue).toContain('hue-rotate(')
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.dataset.firedCues ?? ''), { timeout: testBudget(10_000) }).toContain('glitch')
    expect(await sheet().getByRole('group', { name: 'Crash segment', exact: true }).textContent()).toContain('crash look')
    await sheet().getByRole('button', { name: 'Source', exact: true }).click()
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.dataset.look)).toBe('none')

    await renderBtn.click()
    await sheet().waitFor({ state: 'hidden', timeout: testBudget(45_000) })
    await expect.poll(async () => (await call<NotebookWire>('get_notebook', { notebook_id: notebookId })).cells.length, { timeout: testBudget(45_000) }).toBe(2)
    const afterFirst = await call<NotebookWire>('get_notebook', { notebook_id: notebookId })
    const outputCell = afterFirst.cells.find((cell) => cell.output_artifact_id !== sourceId)!
    expect(outputCell.slot).toEqual({ row: 1, column: 0 })
    const outputDuration = await page.evaluate(async ({ book, artifact }) => {
      const el = document.createElement('video')
      el.muted = true
      el.src = `/files/${book}/${artifact}/original.mp4`
      document.body.append(el)
      await el.play()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const result = { duration: el.duration, width: el.videoWidth, currentTime: el.currentTime }
      el.pause()
      el.remove()
      return result
    }, { book: bookId, artifact: outputCell.output_artifact_id })
    expect(outputDuration.width).toBe(160)
    expect(outputDuration.currentTime).toBeGreaterThan(0)

    await page.locator(`.react-flow__node[data-id="${outputCell.id}"]`).waitFor({ state: 'visible' })

    await command('/auto-edit @a1')
    await sheet().waitFor({ state: 'visible' })
    await sheet().getByRole('button', { name: /^Render/ }).click()
    await sheet().waitFor({ state: 'hidden', timeout: testBudget(45_000) })
    await expect.poll(async () => {
      const nb = await call<NotebookWire>('get_notebook', { notebook_id: notebookId })
      return nb.cells.find((cell) => cell.id === outputCell.id)?.inputs?.outputVersionArtifactIds?.length ?? 0
    }, { timeout: testBudget(45_000) }).toBe(2)
    expect((await call<NotebookWire>('get_notebook', { notebook_id: notebookId })).cells).toHaveLength(2)

    process.env.OPENAI_API_KEY = 'offline-auto-edit-key'
    await command('add a cold open and a slow-mo replay to @a1')
    await sheet().waitFor({ state: 'visible', timeout: testBudget(20_000) })
    expect(stubRequests.some((req) => req.kind === 'chat' && req.queryOrPrompt.includes('show_auto_edit'))).toBe(true)

    const analyzeCountBefore = stubRequests.filter((req) => req.kind === 'analysis').length
    await findButton.click()
    const confirmAnalyze = sheet().getByRole('button', { name: /^Run · / })
    await confirmAnalyze.waitFor({ state: 'visible' })
    expect(stubRequests.filter((req) => req.kind === 'analysis')).toHaveLength(analyzeCountBefore)
    expect(await sheet().textContent()).toContain('Estimated cost')
    await confirmAnalyze.click()

    await expect.poll(() => sheet().textContent(), { timeout: testBudget(30_000) }).toContain('Stubbed sofa leap highlight.')
    expect(await sheet().textContent()).toContain('High confidence')
    expect(stubRequests.filter((req) => req.kind === 'analysis')).toHaveLength(analyzeCountBefore + 1)
    const peakLabel = () => marker('moment.peak').getAttribute('aria-label')
    await expect.poll(peakLabel).toBe('Moment peak 5.50s')

    const bodyLength = () => sheet().locator('.auto-edit-segment[data-tone="body"] .auto-edit-segment-length').first().innerText()
    await expect.poll(bodyLength).toContain('1 cut')
    await sheet().locator('.auto-edit-segment[data-tone="body"]').first().click()
    const cutRow = sheet().getByRole('group', { name: /^Cut 3\.4\d–3\.9\d s$/ })
    await cutRow.getByRole('button', { name: 'Keep this part', exact: true }).click()
    await expect.poll(bodyLength).not.toContain('cut')

    await sheet().getByRole('button', { name: /^Cancel/ }).focus()
    await page.keyboard.press('Escape')
    await sheet().waitFor({ state: 'hidden' })

    await command('/auto-edit @a1')
    await sheet().waitFor({ state: 'visible' })
    await expect.poll(peakLabel).toBe('Moment peak 5.50s')
    expect(stubRequests.filter((req) => req.kind === 'analysis')).toHaveLength(analyzeCountBefore + 1)
    expect(calls.filter((name) => name === 'auto_edit').length).toBeGreaterThanOrEqual(4)
    expect(errors).toEqual([])
  }, testBudget(180_000))
})
