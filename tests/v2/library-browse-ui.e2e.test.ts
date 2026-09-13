import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page, Route } from 'playwright'
import sharp from 'sharp'
import type { IndexManifest } from 'videobook-engine'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { callTool } from './mcp-http-test-server.js'
import {
  seedMixedStatusCatalog,
  seedRetryableFailedImage,
} from './library-browse-fixture.js'

interface StartedProcess {
  child: ChildProcess
  output: string[]
}

const execFileAsync = promisify(execFile)
const longBookName = 'other-library-with-a-long-project-name-for-layout-verification'
const longVideoLabel = 'Evening skyline with a slow pan across the waterfront and the city lights'
const metadataManifest: IndexManifest = {
  manifestId: 'library-ui-metadata-v1', provider: 'fixture', modelId: 'fixture',
  modelRevision: '1', license: 'test', embeddingSpace: 'library-ui-lexical', dimensions: 3,
  modalities: ['metadata'], supportedLanguages: ['en'], preprocessingVersion: '1',
  extractorVersion: '1', createdAt: 1,
}

function browseArguments(route: Route): Record<string, unknown> | null {
  const body = route.request().postDataJSON() as {
    method?: string
    params?: { name?: string; arguments?: Record<string, unknown> }
  } | null
  return body?.method === 'tools/call'
    && ['search_library_assets', 'list_assets'].includes(body.params?.name ?? '')
    && body.params?.arguments?.browse_status
    ? body.params.arguments
    : null
}

async function selectStatus(page: Page, status: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${status}(?: \\d+)?$`) }).click()
  await expect.poll(async () => page.locator('.library-loading').count()).toBe(0)
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not reserve a port')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

function startProcess(args: string[], env: NodeJS.ProcessEnv): StartedProcess {
  const output: string[] = []
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (data: Buffer) => output.push(data.toString()))
  child.stderr.on('data', (data: Buffer) => output.push(data.toString()))
  return { child, output }
}

async function waitForHttp(
  url: string,
  processState: StartedProcess,
  acceptedStatus: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (processState.child.exitCode !== null) {
      throw new Error(`Process exited during startup:\n${processState.output.join('')}`)
    }
    try {
      const response = await fetch(url)
      if (response.status === acceptedStatus) return
    } catch {
      await wait(100)
    }
  }
  throw new Error(`Process did not start:\n${processState.output.join('')}`)
}

async function stopProcess(processState: StartedProcess | undefined): Promise<void> {
  if (!processState || processState.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => {
    processState.child.once('exit', () => resolve())
  })
  processState.child.kill('SIGINT')
  const stopped = await Promise.race([
    exited.then(() => true),
    wait(5_000).then(() => false),
  ])
  if (stopped) return
  processState.child.kill('SIGKILL')
  await exited
}

async function openLibrary(page: Page, appUrl: string): Promise<void> {
  await page.goto(`${appUrl}/library`, { waitUntil: 'commit' })
  await page.getByLabel('Search the library').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByRole('group', { name: 'Browse status' }).waitFor({ state: 'visible' })
}

async function expectReadyGrid(page: Page): Promise<void> {
  await expect.poll(async () =>
    page.getByRole('button', { name: /^Ready/ }).getAttribute('aria-pressed')).toBe('true')
  await page.getByText('Kitchen still').first().waitFor({ state: 'visible' })
  expect(await page.locator('.library-asset-card-error').count()).toBe(0)
  expect(await page.getByRole('button', { name: /^Retry/ }).count()).toBe(0)
  expect(await page.locator('.library-asset-card-grid video').count()).toBe(0)
  const titles = await page.locator('.library-asset-copy strong').allTextContents()
  expect(titles.some((title) => title.includes('Kitchen still'))).toBe(true)
  expect(titles.every((title) => !/^[0-9a-f-]{8,}$/i.test(title.trim()))).toBe(true)
  const dates = await page.locator('.library-asset-copy small').allTextContents()
  expect(dates.every((value) => !value.includes('T') && !/^\d{4}-\d{2}-\d{2}/.test(value.trim())))
    .toBe(true)
}

describe('Library Ready-by-default browser flow', () => {
  let rootDir = ''
  let mcpProcess: StartedProcess | undefined
  let viteProcess: StartedProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let appUrl = ''
  let client: Client
  let primaryBookId = ''
  let kitchenId = ''
  let thumbnailVideoId = ''
  let mediaPng: Buffer

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-library-ui-e2e-'))
    const books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
    const created = await books.create('library-ui')
    const other = await books.create(longBookName)
    if (!created.ok || !other.ok) throw new Error('Could not seed library browser books')
    const thisBook = books.get(created.value.bookId)
    const otherBook = books.get(other.value.bookId)
    if (!thisBook.ok || !otherBook.ok) throw new Error('Could not open library browser books')
    primaryBookId = created.value.bookId
    await seedMixedStatusCatalog(otherBook.value.engine, {
      ready: 205,
      error: 1,
      processing: 0,
    })
    await seedMixedStatusCatalog(thisBook.value.engine, {
      ready: 0,
      error: 0,
      processing: 1,
    })
    const ready = await thisBook.value.engine.artifacts.create({
      kind: 'image',
      label: 'Kitchen still',
    })
    if (!ready.ok) throw new Error(ready.error.message)
    kitchenId = ready.value.artifactId
    mediaPng = await sharp({ create: {
      width: 640, height: 360, channels: 3, background: '#376d46',
    } }).png().toBuffer()
    const written = await thisBook.value.engine.files.write(
      ready.value.artifactId,
      'original.png',
      mediaPng,
    )
    if (!written.ok) throw new Error(written.error.message)
    const manifest = await thisBook.value.engine.files.manifest(kitchenId)
    if (!manifest.ok) throw new Error(manifest.error.message)
    const source = manifest.value.files.find((file) => file.name === 'original.png')
    if (!source) throw new Error('Kitchen still source was not saved')
    const registered = thisBook.value.engine.temporalSearch.manifests.register(metadataManifest)
    if (!registered.ok) throw new Error(registered.error.message)
    const indexed = thisBook.value.engine.temporalSearch.commitBatch({
      artifactId: kitchenId, objectHash: source.objectHash,
      manifestId: metadataManifest.manifestId, generation: 'library-ui',
      phase: 'lexical', maxUnits: 1,
      observations: [{
        artifactId: kitchenId, objectHash: source.objectHash, sourcePath: source.name,
        kind: 'frame', segmentationVersion: '1',
        texts: [{ kind: 'description', language: 'en', text: 'Kitchen still' }],
        embeddings: [], fingerprints: [],
      }],
      coveredRanges: [], totalUnits: 1, complete: true,
    })
    if (!indexed.ok) throw new Error(indexed.error.message)
    const activated = thisBook.value.engine.temporalSearch.activate(metadataManifest.manifestId, 'library-ui')
    if (!activated.ok) throw new Error(activated.error.message)
    await seedRetryableFailedImage(thisBook.value.engine, 'Broken import')
    const videoPath = join(rootDir, 'preview.mp4')
    const audioPath = join(rootDir, 'preview.wav')
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=12',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath])
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12',
      '-c:a', 'pcm_s16le', audioPath])
    const probe = await probeVideo(videoPath)
    for (const [kind, label, path, thumbnail] of [
      ['video', longVideoLabel, videoPath, true],
      ['video', 'Video without a thumbnail', videoPath, false],
      ['audio', 'Quiet tone', audioPath, false],
    ] as const) {
      const asset = await thisBook.value.engine.artifacts.create({ kind, label })
      if (!asset.ok) throw new Error(asset.error.message)
      const copied = await thisBook.value.engine.files.writeFromPath(
        asset.value.artifactId, kind === 'video' ? 'original.mp4' : 'original.wav', path,
      )
      if (!copied.ok) throw new Error(copied.error.message)
      await thisBook.value.engine.metadata.artifacts.write(asset.value.artifactId, 'original', probe)
      if (thumbnail) {
        thumbnailVideoId = asset.value.artifactId
        await thisBook.value.engine.files.write(asset.value.artifactId, 'original.jpg',
          await sharp(mediaPng).jpeg().toBuffer())
      }
    }
    const note = await thisBook.value.engine.artifacts.create({ kind: 'prompt', label: 'Notebook prompt only' })
    if (!note.ok) throw new Error(note.error.message)
    await books.close()

    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    const mcpOrigin = `http://127.0.0.1:${mcpPort}`
    appUrl = `http://127.0.0.1:${vitePort}`
    mcpProcess = startProcess(
      ['--import', 'tsx', 'server/src/index.ts'],
      {
        ...process.env,
        PORT: String(mcpPort),
        VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime', 'app-state.json'),
        VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
      },
    )
    await waitForHttp(`${mcpOrigin}/healthz`, mcpProcess, 200)
    client = new Client({ name: 'library-browser-review', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp`)))
    viteProcess = startProcess(
      [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort)],
      {
        ...process.env,
        VIDEOBOOK_SERVER_URL: mcpOrigin,
        VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache'),
      },
    )
    await waitForHttp(appUrl, viteProcess, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.addInitScript((bookId) => {
      localStorage.setItem('videobook.active-book', bookId)
    }, primaryBookId)
  }, 120_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await client?.close()
    await stopProcess(viteProcess)
    await stopProcess(mcpProcess)
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('opens Ready media, exposes recovery views, and keeps search/import', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openLibrary(page, appUrl)
    await expect.poll(async () => page!.locator('.library-asset-card').count(), {
      timeout: 30_000,
    }).toBeGreaterThan(0)
    await expectReadyGrid(page)
    await page.getByPlaceholder('Search moments or paste a video URL').waitFor({ state: 'visible' })
    await page.getByTitle('Import files').waitFor({ state: 'visible' })
    await page.getByLabel('Open Jobs').waitFor({ state: 'visible' })

    await page.getByRole('button', { name: /^Errors/ }).click()
    await expect.poll(async () =>
      page!.getByRole('button', { name: /^Errors/ }).getAttribute('aria-pressed')).toBe('true')
    await page.getByText('Broken import').first().waitFor({ state: 'visible' })
    await page.getByRole('button', { name: /^Retry/ }).first().waitFor({ state: 'visible' })
    expect(await page.locator('.library-asset-card-row').count()).toBeGreaterThan(0)

    await page.getByRole('button', { name: /^Processing/ }).click()
    await expect.poll(async () =>
      page!.getByRole('button', { name: /^Processing/ }).getAttribute('aria-pressed')).toBe('true')
    expect(await page.locator('.library-asset-card-error').count()).toBe(0)

    await page.getByRole('button', { name: /^Errors/ }).click()
    await page.getByRole('button', { name: /^Retry/ }).first().click()
    let retryCounts = { ready: 0, processing: 0, errors: 0 }
    await expect.poll(async () => {
      const countOn = async (status: string) => {
        await selectStatus(page!, status)
        return page!.locator('.library-asset-copy strong').evaluateAll((nodes) =>
          nodes.filter((node) => (node.textContent ?? '').includes('Broken import')).length)
      }
      retryCounts = {
        ready: await countOn('Ready'),
        processing: await countOn('Processing'),
        errors: await countOn('Errors'),
      }
      return retryCounts.errors === 0
        && retryCounts.ready + retryCounts.processing === 1
    }, { timeout: 60_000 }).toBe(true)
    expect(retryCounts.ready + retryCounts.processing).toBe(1)
    await page.getByRole('button', { name: /^Ready/ }).click()
    const kitchen = page.locator('.library-asset-card', { hasText: 'Kitchen still' }).first()
    await kitchen.scrollIntoViewIfNeeded()
    const bookButton = kitchen.getByTitle('Show only library-ui')
    if (await bookButton.count()) await bookButton.click()
    await expect.poll(async () =>
      page!.getByRole('button', { name: 'This book' }).getAttribute('aria-pressed')).toBe('true')
    await page.getByText('Kitchen still').first().waitFor({ state: 'visible' })
    const ownedKitchen = page.locator('.library-asset-card', { hasText: 'Kitchen still' }).first()
    await ownedKitchen.getByTitle('More actions').click()
    await ownedKitchen.getByRole('menuitem', { name: 'Forget' }).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')

    const screenshotDir = process.env.LIBRARY_SCREENSHOT_DIR
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true })
      await page.getByRole('button', { name: /^Ready/ }).click()
      for (const width of [320, 390, 768, 1280, 2048]) {
        await page.setViewportSize({ width, height: 900 })
        await page.screenshot({
          path: join(screenshotDir, `library-${width}.png`),
          fullPage: true,
        })
      }
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.evaluate(() => {
        document.documentElement.style.zoom = '2'
      })
      await page.screenshot({
        path: join(screenshotDir, 'library-200pct.png'),
        fullPage: true,
      })
      await page.evaluate(() => {
        document.documentElement.style.zoom = '1'
      })
    }
  }, 120_000)

  it('returns to Ready without historical failure cards after leaving the screen', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.getByLabel('Open Jobs').click()
    await expect.poll(async () => page!.evaluate(() => window.location.pathname)).toBe('/jobs')
    await page.getByLabel('Open Library').click()
    await page.getByLabel('Search the library').waitFor({ state: 'visible', timeout: 30_000 })
    await expectReadyGrid(page)
    expect(await page.getByRole('button', { name: /^Retry/ }).count()).toBe(0)
  }, 60_000)

  it('plays thumbnail-backed video, switches media and supports keyboard action menus', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByRole('button', { name: 'All books', exact: true }).click()
    await selectStatus(page, 'Ready')
    const video = page.locator('.library-asset-card', { hasText: longVideoLabel })
    await expect.poll(async () => video.locator('img').evaluate((image) =>
      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
    expect(await video.locator('video').count()).toBe(0)
    await video.getByRole('button', { name: `Play ${longVideoLabel}`, exact: true }).click()
    await expect.poll(async () => video.locator('video').evaluate((media) =>
      (media as HTMLVideoElement).currentTime), { timeout: 15_000 }).toBeGreaterThan(0.1)
    const second = page.locator('.library-asset-card', { hasText: 'Video without a thumbnail' })
    await second.getByRole('button', { name: 'Play Video without a thumbnail', exact: true }).click()
    await expect.poll(async () => second.locator('video').evaluate((media) =>
      (media as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1)
    expect(await video.locator('video').count()).toBe(0)
    const audio = page.locator('.library-asset-card', { hasText: 'Quiet tone' })
    await audio.getByRole('button', { name: 'Play Quiet tone', exact: true }).click()
    await expect.poll(async () => audio.locator('audio').evaluate((media) =>
      (media as HTMLAudioElement).currentTime)).toBeGreaterThan(0.1)
    expect(await page.locator('.library-asset-card video').count()).toBe(0)
    const kitchen = page.locator('.library-asset-card', { hasText: 'Kitchen still' })
    expect(await kitchen.getByRole('link', { name: 'Open Kitchen still', exact: true }).getAttribute('href'))
      .toContain(kitchenId)
    const trigger = kitchen.getByRole('button', { name: 'More actions for Kitchen still', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const forget = kitchen.getByRole('menuitem', { name: 'Forget', exact: true })
    await expect.poll(async () => forget.evaluate((button) => button === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    expect(await trigger.evaluate((button) => button === document.activeElement)).toBe(true)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Tab')
    expect(await kitchen.getByRole('menu').count()).toBe(0)
    await trigger.click()
    page.once('dialog', (dialog) => void dialog.dismiss())
    await forget.click()
    expect(await trigger.evaluate((button) => button === document.activeElement)).toBe(true)
    await selectStatus(page, 'Processing')
    expect(await page.locator('.library-asset-card :is(video,audio)').count()).toBe(0)
  }, 60_000)

  it('keeps all three browse pages and accepts refreshed labels over stale notebook data', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await selectStatus(page, 'Ready')
    await expect.poll(async () => page!.locator('.library-asset-card').count()).toBe(100)
    expect(await page.getByText('Notebook prompt only', { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Load more', exact: true }).click()
    await expect.poll(async () => page!.locator('.library-asset-card').count()).toBe(200)
    await page.getByRole('button', { name: 'Load more', exact: true }).click()
    await expect.poll(async () => page!.locator('.library-asset-card').count()).toBe(210)
    expect(await page.getByRole('button', { name: 'Load more', exact: true }).count()).toBe(0)
    await callTool(client, 'rename_asset', {
      book_id: primaryBookId, asset_id: kitchenId, new_name: 'Kitchen still renamed externally',
    })
    await page.getByText('Kitchen still renamed externally', { exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 })
    expect(await page.locator('.library-asset-card').count()).toBe(210)
    expect(await page.locator('.library-heading-copy h2').textContent()).toContain('210 ready items')
    await callTool(client, 'rename_asset', {
      book_id: primaryBookId, asset_id: kitchenId, new_name: 'Kitchen still',
    })
    await page.getByText('Kitchen still', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  }, 90_000)

  it('ignores a delayed error view after switching scope and recovers a failed browse request', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    let release = () => {}
    const released = new Promise<void>((resolve) => { release = resolve })
    let finishDelivery = () => {}
    const deliveryFinished = new Promise<void>((resolve) => { finishDelivery = resolve })
    let held = false
    let delivered = false
    let failReads = false
    const intercept = async (route: Route) => {
      const args = browseArguments(route)
      if (args?.browse_status === 'error' && !held) {
        const response = await route.fetch()
        held = true
        await released
        try {
          await route.fulfill({ response })
          delivered = true
        } finally {
          finishDelivery()
        }
        return
      }
      if (args?.browse_status === 'processing' && failReads) {
        await route.abort('failed')
        return
      }
      await route.fallback()
    }
    await page.route('**/mcp', intercept)
    try {
      await page.getByRole('button', { name: /^Errors/ }).click()
      await expect.poll(() => held, { timeout: 30_000 }).toBe(true)
      await page.getByRole('button', { name: 'This book', exact: true }).click()
      await selectStatus(page, 'Ready')
      await page.getByText('Kitchen still', { exact: true }).waitFor({ state: 'visible' })
      expect(await page.getByText('Notebook prompt only', { exact: true }).count()).toBe(0)
      release()
      await expect.poll(() => delivered).toBe(true)
      expect(await page.locator('.library-asset-card-error').count()).toBe(0)
      expect(await page.getByText(longBookName, { exact: true }).count()).toBe(0)
      failReads = true
      await page.getByRole('button', { name: /^Processing/ }).click()
      await page.getByRole('button', { name: 'Retry loading', exact: true }).waitFor({ state: 'visible' })
      expect(await page.locator('.library-empty').count()).toBe(0)
      failReads = false
      await page.getByText('processing still 1', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
      expect(await page.locator('.library-load-error').count()).toBe(0)
    } finally {
      release()
      if (held) await deliveryFinished
      await page.unroute('**/mcp', intercept)
    }
  }, 90_000)

  it('contains long cards and controls across responsive sizes and zoom', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.getByRole('button', { name: 'All books', exact: true }).click()
    await selectStatus(page, 'Ready')
    await page.getByText(longBookName, { exact: true }).first().waitFor({ state: 'visible' })
    const screenshotDir = process.env.LIBRARY_SCREENSHOT_DIR
    if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
    for (const width of [320, 390, 768, 1280, 2048]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(await page.locator('.library-asset-body').evaluateAll((bodies) => bodies.every((body) =>
        body.scrollWidth <= body.clientWidth + 1))).toBe(true)
      expect(await page.locator('.library-asset-book').evaluateAll((buttons) => buttons.every((button) => {
        const parent = button.closest('.library-asset-body')!.getBoundingClientRect()
        const bounds = button.getBoundingClientRect()
        return bounds.left >= parent.left && bounds.right <= parent.right
      }))).toBe(true)
      await page.locator('.library-drop-zone').evaluate((element) => { element.scrollTop = 0 })
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `review-library-${width}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.evaluate(() => { document.documentElement.style.zoom = '2' })
    try {
      expect(await page.locator('.library-drop-zone').evaluate((element) =>
        element.getBoundingClientRect().right <= window.innerWidth + 1)).toBe(true)
      expect(await page.locator('.library-drop-zone').evaluate((element) =>
        element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'review-library-200pct.png') })
    } finally {
      await page.evaluate(() => { document.documentElement.style.zoom = '1' })
    }
    const failThumbnail = async (route: Route) => { await route.abort('failed') }
    await page.route(`**/${thumbnailVideoId}/original.jpg*`, failThumbnail)
    await page.reload({ waitUntil: 'commit' })
    const video = page.locator('.library-asset-card', { hasText: longVideoLabel })
    try {
      await video.locator('.library-asset-fallback').waitFor({ state: 'visible' })
      await video.getByRole('button', { name: `Play ${longVideoLabel}`, exact: true }).click()
      await expect.poll(async () => video.locator('video').evaluate((media) =>
        (media as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1)
    } finally {
      await page.unroute(`**/${thumbnailVideoId}/original.jpg*`, failThumbnail)
    }
  }, 90_000)

  it('imports a new image and searches media metadata in the selected book', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.getByRole('button', { name: 'This book', exact: true }).click()
    await selectStatus(page, 'Ready')
    expect(await page.locator('.library-asset-card', { hasText: 'Notebook prompt only' }).count()).toBe(0)
    const before = await callTool<{ page: { total: number } }>(client, 'list_assets', {
      book_id: primaryBookId, browse_status: 'ready',
    })
    const upload = await sharp({ create: {
      width: 80, height: 45, channels: 3, background: '#535b70',
    } }).png().toBuffer()
    await page.getByLabel('Import files', { exact: true }).setInputFiles({
      name: 'library-review-upload.png', mimeType: 'image/png', buffer: upload,
    })
    await page.getByText('Imported 1', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => page!.locator('.library-asset-card').count(), { timeout: 30_000 })
      .toBe(before.page.total + 1)
    await page.getByRole('combobox', { name: 'Signal', exact: true }).selectOption('metadata')
    await page.getByLabel('Search the library', { exact: true }).fill('Kitchen still')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.locator('.moment-card', { hasText: 'Kitchen still' }).waitFor({ state: 'visible', timeout: 30_000 })
    expect(await page.getByRole('button', { name: 'This book', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await page.locator('.library-asset-card-error').count()).toBe(0)
  }, 60_000)

  it('keeps card and status actions large enough for touch at phone width', async () => {
    if (!browser) throw new Error('Browser was not initialized')
    const touchPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    try {
      await touchPage.addInitScript((bookId) => {
        localStorage.setItem('videobook.active-book', bookId)
        localStorage.setItem('videobook.library-scope', 'book')
      }, primaryBookId)
      await openLibrary(touchPage, appUrl)
      await expectReadyGrid(touchPage)
      expect(await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
      const targets = await touchPage.locator('.library-asset-card :is(button, a), .library-status-control button')
        .evaluateAll((elements) => elements.map((element) => {
          const bounds = element.getBoundingClientRect()
          return { width: bounds.width, height: bounds.height }
        }))
      expect(targets.length).toBeGreaterThan(4)
      for (const target of targets) {
        expect(target.width).toBeGreaterThanOrEqual(44)
        expect(target.height).toBeGreaterThanOrEqual(44)
      }
    } finally {
      await touchPage.close()
    }
  })
})
