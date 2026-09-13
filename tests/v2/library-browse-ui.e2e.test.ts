import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import {
  seedMixedStatusCatalog,
  seedRetryableFailedImage,
} from './library-browse-fixture.js'

interface StartedProcess {
  child: ChildProcess
  output: string[]
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

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-library-ui-e2e-'))
    const books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
    const created = await books.create('library-ui')
    const other = await books.create('other-library')
    if (!created.ok || !other.ok) throw new Error('Could not seed library browser books')
    const thisBook = books.get(created.value.bookId)
    const otherBook = books.get(other.value.bookId)
    if (!thisBook.ok || !otherBook.ok) throw new Error('Could not open library browser books')
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
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64',
    )
    const written = await thisBook.value.engine.files.write(
      ready.value.artifactId,
      'original.png',
      png,
    )
    if (!written.ok) throw new Error(written.error.message)
    await seedRetryableFailedImage(thisBook.value.engine, 'Broken import')
    await seedMixedStatusCatalog(otherBook.value.engine, {
      ready: 0,
      error: 1,
      processing: 0,
    })
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
  }, 120_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
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
        await page!.getByRole('button', { name: new RegExp(`^${status}`) }).click()
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
})
