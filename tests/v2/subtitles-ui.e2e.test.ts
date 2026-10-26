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
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { registerMediaProbe } from '../../server/src/notebook-media-ops.js'
import { extractVideoPoster } from '../../server/src/video-poster.js'
import { availablePort, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

const exec = promisify(execFile)
const SHOTS = process.env.VIDEOBOOK_E2E_SHOTS ?? null
const TRANSCRIPT = {
  language_code: 'eng',
  words: [
    { text: 'We', start: 0.4, end: 0.6, type: 'word' },
    { text: 'ride', start: 0.65, end: 0.95, type: 'word' },
    { text: 'tonight.', start: 1.0, end: 1.5, type: 'word' },
    { text: 'Hold', start: 2.0, end: 2.3, type: 'word' },
    { text: 'on', start: 2.35, end: 2.5, type: 'word' },
    { text: 'tight.', start: 2.55, end: 3.1, type: 'word' },
  ],
}

describe('subtitle editor in the composer', () => {
  let root = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser | undefined
  let client: Client | undefined
  let page: Page
  let bookId = ''
  let appUrl = ''
  let sourceId = ''
  let secondId = ''
  let notebookId = ''
  const calls: string[] = []
  const errors: string[] = []
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(await client!.callTool({ name, arguments: { book_id: bookId, ...args } })) as T
  const sheet = () => page.getByRole('dialog', { name: 'Subtitles editor', exact: true })
  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
  }
  type Read = { status: string; draft: { revision: string; saved: boolean; corrected_words: number } | null; document: { positions: Record<string, number>; phrases: Array<{ id: string; positions: Record<string, number> }>; words: Array<{ id: string; text: string; start: number; textCorrected: boolean; timingCorrected: boolean }> } }
  type NotebookWire = { cells: Array<{ id: string; output_artifact_id?: string; slot: { row: number; column: number } }> }
  const draft = (assetId = sourceId) => call<Read>('caption_video', { asset_id: assetId, detail: 'full' })
  const saved = () => expect.poll(() => sheet().locator('.subtitles-save-state').textContent(), { timeout: 15_000 }).toBe('Saved')
  const word = (text: string) => sheet().locator('.subtitles-word', { hasText: new RegExp(`^${text}$`) })
  const shot = async (name: string) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-subtitles-ui-'))
    const fixture = join(root, 'source.mp4')
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture])
    const manager = new BookManager({ libraryDir: join(root, 'books') })
    const created = await manager.create('subtitles-ui')
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const found = manager.get(bookId)
    if (!found.ok) throw new Error(found.error.message)
    const engine = found.value.engine
    const source = await engine.artifacts.create({ kind: 'video', label: 'Night ride' })
    if (!source.ok) throw new Error(source.error.message)
    await engine.files.writeFromPath(source.value.artifactId, 'original.mp4', fixture)
    await registerMediaProbe(engine, source.value.artifactId, 'original.mp4', await probeVideo(fixture))
    await engine.files.write(source.value.artifactId, 'original.jpg', await extractVideoPoster(fixture, 4))
    await engine.files.write(source.value.artifactId, 'elevenlabs.json', JSON.stringify(TRANSCRIPT))
    sourceId = source.value.artifactId
    const second = await engine.artifacts.create({ kind: 'video', label: 'Second take' })
    if (!second.ok) throw new Error(second.error.message)
    secondId = second.value.artifactId
    const secondFixture = join(root, 'second.mp4')
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=480x480:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', secondFixture])
    await engine.files.writeFromPath(secondId, 'original.mp4', secondFixture)
    await registerMediaProbe(engine, secondId, 'original.mp4', await probeVideo(secondFixture))
    await engine.files.write(secondId, 'original.jpg', await extractVideoPoster(secondFixture, 3))
    await engine.files.write(secondId, 'elevenlabs.json', JSON.stringify({ language_code: 'eng', words: [{ text: 'Second', start: 0.3, end: 0.8, type: 'word' }, { text: 'take', start: 0.9, end: 1.4, type: 'word' }] }))
    const notebook = engine.notebooks.list()[0]!
    notebookId = notebook.id
    await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 0 }, outputArtifactId: sourceId }))
    await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 1 }, outputArtifactId: secondId }))
    await manager.close()
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    const env = { ...process.env, NODE_ENV: 'test', OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '', PORT: String(port), VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json') }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'subtitles-ui', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
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
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (root) await rm(root, { recursive: true, force: true })
  }, 30_000)

  it('opens from chat, previews with audio, edits words, timing and positions, survives reload and renders a playable cell', async () => {
    await command('/subs @a1')
    await sheet().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => word('ride').isVisible(), { timeout: 30_000 }).toBe(true)
    await shot('subtitles-desktop')
    expect(calls.filter((name) => name === 'caption_video').length).toBeGreaterThan(0)

    const stage = sheet().locator('.subtitles-stage')
    const stageBox = await stage.boundingBox()
    expect(stageBox!.height).toBeGreaterThan(300)
    expect(Math.abs(stageBox!.width / stageBox!.height - 9 / 16)).toBeLessThan(0.02)

    await sheet().getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(() => stage.locator('video').evaluateAll((videos: HTMLVideoElement[]) => Math.max(...videos.map((video) => video.currentTime))), { timeout: 10_000 }).toBeGreaterThan(0.3)
    const audible = await stage.locator('video').evaluateAll((videos: HTMLVideoElement[]) => videos.some((video) => !video.muted && video.volume > 0))
    expect(audible).toBe(true)
    await sheet().getByRole('button', { name: 'Pause', exact: true }).click()

    await word('ride').click()
    await expect.poll(() => word('ride').getAttribute('data-active'), { timeout: 10_000 }).toBe('true')
    await expect.poll(() => stage.evaluate((element) => [...element.querySelectorAll('span')].find((span) => span.textContent === 'ride')?.style.color ?? null), { timeout: 10_000 }).toBe('rgb(255, 225, 77)')

    await shot('subtitles-word-selected')
    const editor = sheet().getByLabel('Word text', { exact: true })
    await editor.fill('rode')
    await editor.press('Enter')
    await expect.poll(() => word('rode').isVisible()).toBe(true)
    expect(await sheet().isVisible()).toBe(true)
    await saved()
    expect((await draft()).document.words.find((item) => item.text === 'rode')).toMatchObject({ textCorrected: true })

    await word('rode').click()
    await sheet().getByRole('button', { name: 'start 50 ms later', exact: true }).click()
    await saved()
    expect((await draft()).document.words.find((item) => item.text === 'rode')).toMatchObject({ start: 0.7, timingCorrected: true })

    const slider = sheet().getByLabel('Subtitle vertical position, percent from top', { exact: true })
    await slider.focus()
    for (let step = 0; step < 5; step += 1) await slider.press('ArrowUp')
    await saved()
    expect((await draft()).document.positions['9:16']).toBeCloseTo(0.705, 3)

    await word('Hold').click()
    const block = sheet().locator('.subtitles-drag-block')
    await block.waitFor({ state: 'visible' })
    const box = (await block.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - stageBox!.height * 0.2, { steps: 6 })
    await page.mouse.up()
    await saved()
    await shot('subtitles-dragged')
    expect((await draft()).document.positions['9:16']).toBeLessThan(0.55)

    await sheet().getByRole('button', { name: 'Selected phrase', exact: true }).click()
    const phraseInput = sheet().getByLabel('Vertical position in percent', { exact: true })
    await phraseInput.fill('30')
    await saved()
    const withOverride = await draft()
    expect(withOverride.document.phrases[1].positions).toEqual({ '9:16': 0.3 })
    await sheet().getByRole('button', { name: 'Use all-phrase position', exact: true }).click()
    await saved()
    expect((await draft()).document.phrases[1].positions).toEqual({})
    await phraseInput.fill('25')
    await saved()

    await page.reload()
    await command('/subs @a1')
    await sheet().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => word('rode').isVisible(), { timeout: 30_000 }).toBe(true)
    expect((await draft()).document.phrases[1].positions).toEqual({ '9:16': 0.25 })

    expect((await draft(secondId)).status).toBe('needs_prepare')
    await command('/subs @a2')
    await command('/subs @a1')
    await expect.poll(() => word('rode').isVisible(), { timeout: 30_000 }).toBe(true)
    expect(await word('Second').count()).toBe(0)
    await expect.poll(async () => (await draft(secondId)).status, { timeout: 30_000 }).toBe('ready')
    await command('/subs @a2')
    await expect.poll(() => word('Second').isVisible(), { timeout: 30_000 }).toBe(true)
    expect(await word('rode').count()).toBe(0)
    await command('/subs @a1')
    await expect.poll(() => word('rode').isVisible(), { timeout: 30_000 }).toBe(true)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => sheet().getByRole('button', { name: /^Render/ }).isVisible()).toBe(true)
    expect(await sheet().evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await expect.poll(async () => ((await stage.boundingBox())?.width ?? 0) > 120).toBe(true)
    await shot('subtitles-phone')
    await page.setViewportSize({ width: 1440, height: 1000 })

    await sheet().getByRole('button', { name: /^Render/ }).click()
    await expect.poll(async () => (await call<NotebookWire>('get_notebook', { notebook_id: notebookId })).cells.length, { timeout: 120_000 }).toBe(3)
    await sheet().waitFor({ state: 'hidden', timeout: 30_000 })
    const notebook = await call<NotebookWire>('get_notebook', { notebook_id: notebookId })
    const output = notebook.cells.find((cell) => cell.output_artifact_id !== sourceId && cell.output_artifact_id !== secondId)!
    expect(output.slot).toEqual({ row: 1, column: 0 })
    const playback = await page.evaluate(async ({ book, artifact }) => {
      const video = document.createElement('video')
      video.muted = true
      video.src = `/files/${book}/${artifact}/original.mp4`
      document.body.append(video)
      await video.play()
      await new Promise((resolve) => setTimeout(resolve, 150))
      const result = { duration: video.duration, time: video.currentTime, width: video.videoWidth, height: video.videoHeight }
      video.pause()
      video.remove()
      return result
    }, { book: bookId, artifact: output.output_artifact_id })
    expect(playback.duration).toBeCloseTo(4, 0)
    expect(playback.time).toBeGreaterThan(0)
    expect(playback).toMatchObject({ width: 1080, height: 1920 })
    const download = await page.evaluate(async ({ book, artifact }) => (await fetch(`/files/${book}/${artifact}/original.mp4`)).status, { book: bookId, artifact: output.output_artifact_id })
    expect(download).toBe(200)
    expect(errors).toEqual([])
  }, 300_000)
})
