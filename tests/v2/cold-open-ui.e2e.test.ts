import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { coldOpenCacheKey, coldOpenSource } from '../../server/src/cold-open.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { registerMediaProbe } from '../../server/src/notebook-media-ops.js'
import { INTELLIGENCE_MODEL } from '../../server/src/openai-intelligence.js'
import { extractVideoPoster } from '../../server/src/video-poster.js'
import { availablePort, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

const exec = promisify(execFile)
type NotebookWire = { cells: Array<{ id: string; output_artifact_id?: string; slot: { row: number; column: number } }> }

describe('cold-open review and copy in the browser', () => {
  let root = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser | undefined
  let client: Client | undefined
  let page: Page
  let bookId = ''
  let notebookId = ''
  let sourceId = ''
  let sourceCellId = ''
  let appUrl = ''
  const calls: string[] = []
  const errors: string[] = []
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(await client!.callTool({ name, arguments: { book_id: bookId, ...args } })) as T
  const review = () => page.getByRole('dialog', { name: 'Cold-open review', exact: true })
  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-cold-open-ui-'))
    const fixture = join(root, 'source.mp4')
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=24:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture])
    const manager = new BookManager({ libraryDir: join(root, 'books') })
    const created = await manager.create('cold-open-ui')
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const found = manager.get(bookId)
    if (!found.ok) throw new Error(found.error.message)
    const engine = found.value.engine
    const source = await engine.artifacts.create({ kind: 'video', label: 'Original action' })
    if (!source.ok) throw new Error(source.error.message)
    sourceId = source.value.artifactId
    await engine.files.writeFromPath(sourceId, 'original.mp4', fixture)
    await registerMediaProbe(engine, sourceId, 'original.mp4', await probeVideo(fixture))
    await engine.files.write(sourceId, 'original.jpg', await extractVideoPoster(fixture, 6))
    const notebook = engine.notebooks.list()[0]!
    notebookId = notebook.id
    const cell = engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 0 }, outputArtifactId: sourceId })
    sourceCellId = cell.id
    await engine.notebooks.insertCell(notebook.id, cell)
    const identity = await coldOpenSource(engine, sourceId)
    engine.settings.set(coldOpenCacheKey(identity), {
      sourceArtifactId: sourceId, sourceObjectHash: identity.file.objectHash, durationSeconds: 6, fps: 24,
      startSeconds: 2, endSeconds: 4, reason: 'The action is strongest here.', model: INTELLIGENCE_MODEL,
    })
    await manager.close()
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    const env = { ...process.env, NODE_ENV: 'test', OPENAI_API_KEY: '', PORT: String(port), VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json') }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'cold-open-ui', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    const vitePort = await availablePort()
    appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/mcp')) return
      calls.push(...toolCalls(request.postDataJSON()).map(item => item.name))
    })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (root) await rm(root, { recursive: true, force: true })
  }, 30_000)

  it('discovers, previews, adjusts, cancels, and creates a playable copy without repeating analysis', async () => {
    await command('/edit-cold-open @a1')
    await review().waitFor({ state: 'visible' })
    await review().getByRole('button', { name: /Find highlight/ }).click()
    await expect.poll(() => review().getByLabel('Highlight start').inputValue(), { timeout: 30_000 }).toBe('2')
    await review().getByLabel('Highlight start').fill('1')
    await review().getByLabel('Highlight end').fill('3')
    await review().getByRole('button', { name: 'Preview cold open', exact: true }).click()
    const video = review().getByLabel('Cold-open preview', { exact: true })
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 5000 }).toBeGreaterThan(1.1)
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 5000 }).toBeLessThan(0.9)
    expect(calls.filter(name => name === 'prepare_cold_open')).toHaveLength(1)
    await page.screenshot({ path: '/tmp/videobook-cold-open-desktop.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => review().getByRole('button', { name: /Create copy/ }).isVisible()).toBe(true)
    expect(await review().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: '/tmp/videobook-cold-open-phone.png' })
    await review().getByRole('button', { name: /Cancel/ }).click()
    expect((await call<NotebookWire>('get_notebook', { notebook_id: notebookId })).cells).toHaveLength(1)

    await page.setViewportSize({ width: 1440, height: 1000 })
    const source = page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`)
    await source.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit cold open', exact: true }).click()
    await review().getByRole('button', { name: /Find highlight/ }).click()
    await expect.poll(() => review().getByLabel('Highlight start').inputValue(), { timeout: 30_000 }).toBe('2')
    await review().getByLabel('Highlight start').fill('1')
    await review().getByLabel('Highlight end').fill('3')
    await review().getByRole('button', { name: /Create copy/ }).click()
    await expect.poll(async () => (await call<NotebookWire>('get_notebook', { notebook_id: notebookId })).cells.length, { timeout: 45_000 }).toBe(2)
    await review().waitFor({ state: 'hidden', timeout: 30_000 })
    const notebook = await call<NotebookWire>('get_notebook', { notebook_id: notebookId })
    const output = notebook.cells.find(cell => cell.output_artifact_id !== sourceId)!
    expect(output.slot).toEqual({ row: 1, column: 0 })
    expect(calls.filter(name => name === 'prepare_cold_open')).toHaveLength(2)
    expect(calls.filter(name => name === 'edit_cold_open')).toHaveLength(1)
    const playback = await page.evaluate(async ({ book, artifact }) => {
      const video = document.createElement('video')
      video.muted = true
      video.src = `/files/${book}/${artifact}/original.mp4`
      document.body.append(video)
      await video.play()
      await new Promise(resolve => setTimeout(resolve, 150))
      const result = { duration: video.duration, time: video.currentTime, width: video.videoWidth, height: video.videoHeight }
      video.pause()
      video.remove()
      return result
    }, { book: bookId, artifact: output.output_artifact_id })
    expect(playback.duration).toBeCloseTo(8, 1)
    expect(playback.time).toBeGreaterThan(0)
    expect(playback.width).toBe(160)
    expect(errors).toEqual([])
    const catalog = await call<{ actions: Array<{ command: string; target: { mediaKinds?: string[] } }> }>('list_workspace_actions', { detail: 'full' })
    expect(catalog.actions.find(action => action.command === '/edit-cold-open')?.target.mediaKinds).toEqual(['video', 'final'])
  }, 90_000)
})
