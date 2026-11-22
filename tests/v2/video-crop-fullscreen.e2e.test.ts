import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import type { Browser, Locator, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { registerMediaProbe } from '../../server/src/notebook-media-ops.js'
import { testBudget } from '../../server/src/test-budget.js'
import { extractVideoPoster } from '../../server/src/video-poster.js'
import { availablePort, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { ObservedToolCall, StartedProcess } from './e2e-harness.js'

const exec = promisify(execFile)

type Box = { x: number; y: number; width: number; height: number }

async function boundsOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Element has no bounding box')
  return box
}

async function videoSize(video: Locator): Promise<string> {
  return await video.evaluate((element: HTMLVideoElement) => `${element.videoWidth}x${element.videoHeight}`)
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

describe('cropping a video from the fullscreen viewer', () => {
  let root = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser | undefined
  let page: Page
  let bookId = ''
  let sourceCellId = ''
  const calls: ObservedToolCall[] = []
  const errors: string[] = []

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-video-crop-'))
    const fixture = join(root, 'source.mp4')
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture])
    const manager = new BookManager({ libraryDir: join(root, 'books') })
    const created = await manager.create('video-crop')
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const found = manager.get(bookId)
    if (!found.ok) throw new Error(found.error.message)
    const engine = found.value.engine
    const source = await engine.artifacts.create({ kind: 'video', label: 'Wide shot' })
    if (!source.ok) throw new Error(source.error.message)
    await engine.files.writeFromPath(source.value.artifactId, 'original.mp4', fixture)
    await registerMediaProbe(engine, source.value.artifactId, 'original.mp4', await probeVideo(fixture))
    await engine.files.write(source.value.artifactId, 'original.jpg', await extractVideoPoster(fixture, 2))
    const notebook = engine.notebooks.list()[0]!
    const cell = engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 0 }, outputArtifactId: source.value.artifactId })
    sourceCellId = cell.id
    await engine.notebooks.insertCell(notebook.id, cell)
    await manager.close()
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    const env = { ...process.env, NODE_ENV: 'test', OPENAI_API_KEY: '', KIE_API_KEY: '', FAL_API_KEY: '', PORT: String(port), VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json') }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    const vitePort = await availablePort()
    const appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (request.method() !== 'POST' || !request.url().endsWith('/mcp')) return
      calls.push(...toolCalls(request.postDataJSON()))
    })
    await page.addInitScript((id) => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
  }, testBudget(90_000))

  afterAll(async () => {
    await browser?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }, testBudget(30_000))

  it('moves and resizes a ratio-locked box, cancels, then crops the video in place', async () => {
    await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click({ timeout: testBudget(30_000) })
    await page.getByLabel('Open @a1 fullscreen', { exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Fullscreen preview for @a1' })
    const video = dialog.locator('video')
    await expect.poll(() => videoSize(video), { timeout: testBudget(15_000) }).toBe('640x360')

    await dialog.getByRole('button', { name: 'Crop', exact: true }).click()
    const area = dialog.getByRole('group', { name: 'Crop area, 9:16' })
    await area.waitFor({ state: 'visible' })
    expect(await area.evaluate((element) => document.activeElement === element)).toBe(true)
    expect(await video.evaluate((element: HTMLVideoElement) => element.paused && !element.controls)).toBe(true)
    expect(await dialog.getByRole('button', { name: '9:16', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => dialog.locator('.video-crop-size').textContent()).toBe('203×360 → 1080×1920')

    const frame = await boundsOf(dialog.locator('.video-crop-frame'))
    expect(frame.width / frame.height).toBeCloseTo(16 / 9, 2)
    const header = await boundsOf(dialog.locator('.media-fullscreen-chrome'))
    const toolbar = await boundsOf(dialog.locator('.video-crop-toolbar'))
    expect(frame.y - 7).toBeGreaterThanOrEqual(header.y + header.height)
    expect(frame.y + frame.height + 7).toBeLessThan(toolbar.y)
    const full = await boundsOf(area)
    expect(full.height).toBeCloseTo(frame.height, 0)

    await dialog.getByRole('button', { name: '1:1', exact: true }).click()
    await expect.poll(() => dialog.locator('.video-crop-size').textContent()).toBe('360×360 → 1080×1080')
    await dialog.getByRole('button', { name: '9:16', exact: true }).click()

    await area.focus()
    for (let step = 0; step < 4; step += 1) await page.keyboard.press('-')
    const shrunk = await boundsOf(area)
    expect(shrunk.height).toBeCloseTo(full.height / 1.1 ** 4, 0)
    expect(shrunk.width / shrunk.height).toBeCloseTo(9 / 16, 1)

    await drag(page, { x: shrunk.x + shrunk.width, y: shrunk.y + shrunk.height }, { x: shrunk.x + shrunk.width + 40, y: shrunk.y + shrunk.height + 60 })
    const grown = await boundsOf(area)
    expect(grown.x).toBeCloseTo(shrunk.x, 0)
    expect(grown.y).toBeCloseTo(shrunk.y, 0)
    expect(grown.height).toBeGreaterThan(shrunk.height + 20)
    expect(grown.width / grown.height).toBeCloseTo(9 / 16, 1)

    await drag(page, { x: grown.x + grown.width / 2, y: grown.y + grown.height / 2 }, { x: frame.x - 400, y: grown.y + grown.height / 2 })
    const moved = await boundsOf(area)
    expect(moved.x).toBeCloseTo(frame.x, 0)
    expect(moved.height).toBeCloseTo(grown.height, 0)

    await page.keyboard.press('Escape')
    await area.waitFor({ state: 'detached' })
    expect(await dialog.isVisible()).toBe(true)
    const cropButton = dialog.getByRole('button', { name: 'Crop', exact: true })
    await expect.poll(() => cropButton.evaluate((element) => document.activeElement === element)).toBe(true)
    expect(calls.filter((call) => call.name === 'crop_asset')).toHaveLength(0)
    expect(await video.evaluate((element: HTMLVideoElement) => element.controls)).toBe(true)

    await page.keyboard.press('c')
    await area.waitFor({ state: 'visible' })
    for (let step = 0; step < 6; step += 1) await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Enter')

    await expect.poll(() => dialog.locator('.notebook-media-capture-status').textContent(), { timeout: testBudget(60_000) }).toBe('Cropped @a1 to 9:16')
    const crop = calls.filter((call) => call.name === 'crop_asset')
    expect(crop).toHaveLength(1)
    expect(crop[0]!.arguments).toMatchObject({ book_id: bookId, ratio: '9:16', y: 0, h: 1 })
    expect(Number(crop[0]!.arguments.x) + Number(crop[0]!.arguments.w)).toBeCloseTo(1, 6)
    expect(Number(crop[0]!.arguments.w)).toBeCloseTo(0.31640625, 6)
    await area.waitFor({ state: 'detached' })
    await expect.poll(() => videoSize(video), { timeout: testBudget(30_000) }).toBe('1080x1920')
    expect(await video.evaluate((element: HTMLVideoElement) => element.controls)).toBe(true)
    await expect.poll(() => dialog.locator('.media-fullscreen-details').textContent(), { timeout: testBudget(60_000) }).toContain('1080 × 1920')
    expect(errors).toEqual([])
  }, testBudget(180_000))

  it('keeps the crop controls inside a phone screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    const dialog = page.getByRole('dialog', { name: 'Fullscreen preview for @a1' })
    await dialog.getByRole('button', { name: 'Crop', exact: true }).click()
    const toolbar = dialog.locator('.video-crop-toolbar')
    await toolbar.waitFor({ state: 'visible' })
    const bounds = await boundsOf(toolbar)
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844)
    const area = await boundsOf(dialog.getByRole('group', { name: 'Crop area, 1:1' }))
    expect(area.y + area.height + 7).toBeLessThan(bounds.y)
    const header = await boundsOf(dialog.locator('.media-fullscreen-chrome'))
    const frame = await boundsOf(dialog.locator('.video-crop-frame'))
    expect(frame.y - 7).toBeGreaterThanOrEqual(header.y + header.height - 1)
    expect(await dialog.locator('.video-crop-hint').isVisible()).toBe(false)
    expect(await dialog.getByRole('button', { name: 'Crop to 1:1', exact: true }).isVisible()).toBe(true)
    await page.keyboard.press('Escape')
    await toolbar.waitFor({ state: 'detached' })
  }, testBudget(60_000))
})
