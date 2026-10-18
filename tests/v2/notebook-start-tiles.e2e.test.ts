import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import {
  availablePort,
  record,
  resultValue,
  startProcess,
  stopProcess,
  waitForHttp,
} from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

type Box = { x: number; y: number; width: number; height: number }

type PlacedCell = [string, number, number]

describe('empty notebook start tiles', () => {
  let rootDir = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser
  let client: Client
  let page: Page
  let appUrl = ''
  let bookId = ''
  let notebookId = ''
  let imagePath = ''

  async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return resultValue(await client.callTool({
      name,
      arguments: { book_id: bookId, notebook_id: notebookId, ...args },
    }))
  }

  async function cells(): Promise<Array<Record<string, unknown> | null>> {
    const notebook = record(await call('get_notebook'))
    return (Array.isArray(notebook?.cells) ? notebook.cells : []).map(record)
  }

  async function placedCells(): Promise<PlacedCell[]> {
    return (await cells()).map((cell) => {
      const slot = record(cell?.slot)
      return [String(cell?.type), Number(slot?.row), Number(slot?.column)]
    })
  }

  function input(): Locator {
    return page.getByLabel('Videobook command input', { exact: true })
  }

  function tiles(): Locator {
    return page.getByRole('group', { name: 'Start this notebook', exact: true })
  }

  function tile(address: string): Locator {
    return tiles().locator(`[data-start-address="${address}"]`)
  }

  function toolbar(): Locator {
    return page.getByRole('group', { name: 'Notebook canvas controls' })
  }

  async function ready(): Promise<void> {
    await input().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => input().isEnabled(), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => page.locator('.command-send .busy-indicator').count(), { timeout: 15_000 }).toBe(0)
  }

  async function box(target: Locator): Promise<Box> {
    const bounds = await target.boundingBox()
    if (!bounds) throw new Error('Could not measure the element')
    return bounds
  }

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-start-tiles-e2e-'))
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    const origin = `http://127.0.0.1:${mcpPort}`
    appUrl = `http://127.0.0.1:${vitePort}`
    const env = {
      ...process.env,
      PORT: String(mcpPort),
      VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
      VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime/app-state.json'),
    }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'start-tiles-e2e', version: '1.0.0' }, {
      capabilities: {},
      supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    const book = record(await call('create_book', { name: 'start-tiles' }))
    bookId = String(book?.bookId ?? '')
    const notebooks = await call('list_notebooks')
    notebookId = String(record(Array.isArray(notebooks) ? notebooks[0] : null)?.id ?? '')
    expect(bookId).not.toBe('')
    expect(notebookId).not.toBe('')
    imagePath = join(rootDir, 'still.png')
    await promisify(execFile)(FFMPEG, [
      '-y', '-f', 'lavfi', '-i', 'color=c=0x48b26f:s=96x64', '-frames:v', '1', imagePath,
    ])
    vite = startProcess([
      'node_modules/vite/bin/vite.js', '--host', '127.0.0.1',
      '--port', String(vitePort), '--strictPort',
    ], {
      ...env,
      VIDEOBOOK_SERVER_URL: origin,
      VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache'),
      VIDEOBOOK_VITE_HMR: '0',
    })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
  }, 60_000)

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
    await ready()
    await tiles().waitFor({ state: 'visible', timeout: 30_000 })
  })

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      const path = `/tmp/videobook-start-tiles-${task.name.replace(/[^a-z0-9]+/giu, '-').slice(0, 90)}`
      await page.screenshot({ path: `${path}.png` })
      await writeFile(`${path}.json`, JSON.stringify({ failures: task.result.errors, body: await page.locator('body').innerText() }, null, 2))
    }
    await page?.close()
    for (const cell of await cells()) {
      await call('delete_notebook_cell', { cell_id: cell?.id })
    }
  })

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('lays the four starts exactly over @a1 to @a4 and leaves the rest of the grid open', async () => {
    expect(await page.locator('.canvas-welcome').count()).toBe(0)
    expect(await tiles().locator('.notebook-start-tile').count()).toBe(4)
    const squares = page.locator('.notebook-grid-square')
    expect(await squares.count()).toBeGreaterThanOrEqual(24)
    for (const [index, address] of ['@a1', '@a2', '@a3', '@a4'].entries()) {
      const tileBox = await box(tile(address))
      const squareBox = await box(squares.nth(index))
      expect(Math.abs(tileBox.x - squareBox.x)).toBeLessThan(1.5)
      expect(Math.abs(tileBox.y - squareBox.y)).toBeLessThan(1.5)
      expect(Math.abs(tileBox.width - squareBox.width)).toBeLessThan(1.5)
      expect(Math.abs(tileBox.height - squareBox.height)).toBeLessThan(1.5)
      expect(await tile(address).locator('.notebook-start-tile-head').textContent()).toBe(address)
    }

    const fifth = await box(squares.nth(4))
    expect(await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.classList.contains('react-flow__pane'), {
      x: fifth.x + fifth.width / 2,
      y: fifth.y + fifth.height / 2,
    })).toBe(true)

    const library = await box(tile('@a4'))
    const blank = { x: library.x + library.width / 2, y: library.y + library.height * 0.3 }
    expect(await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.classList.contains('react-flow__pane'), blank)).toBe(true)
  })

  it('prefixes the image and video buttons with a plus', async () => {
    for (const label of ['Add image', 'Add video']) {
      const button = toolbar().getByLabel(label, { exact: true })
      expect(await button.locator('svg.lucide-plus').count()).toBe(1)
      expect(await button.locator('svg.lucide-image, svg.lucide-video').count()).toBe(0)
    }
    expect((await toolbar().getByLabel('Add image', { exact: true }).textContent())?.trim()).toBe('Image')
    expect((await toolbar().getByLabel('Add video', { exact: true }).textContent())?.trim()).toBe('Video')
    for (const [address, label, text] of [['@a1', 'Upload image', 'Image'], ['@a2', 'Upload video', 'Video']]) {
      const button = tile(address).getByRole('button', { name: label, exact: true })
      expect(await button.locator('svg.lucide-plus').count()).toBe(1)
      expect((await button.textContent())?.trim()).toBe(text)
    }
  })

  it('uploads a picture straight into @a1', async () => {
    await tile('@a1').locator('input[type="file"]').setInputFiles(imagePath)
    await expect.poll(placedCells, { timeout: 30_000 }).toEqual([['image', 0, 0]])
    const [cell] = await cells()
    expect(cell?.output_artifact_id).toEqual(expect.any(String))
    await expect.poll(() => tiles().count(), { timeout: 15_000 }).toBe(0)
  })

  it('opens the recent-media picker for a video placed in @a2', async () => {
    await tile('@a2').getByRole('button', { name: 'Video from library', exact: true }).click()
    await page.getByLabel('Empty video media slot', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByLabel('Search library', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    expect(await placedCells()).toEqual([['video', 0, 1]])
    await expect.poll(() => tiles().count(), { timeout: 15_000 }).toBe(0)
  })

  it('keeps a typed clip link in the @a3 field', async () => {
    const link = tile('@a3').getByLabel('Clip link', { exact: true })
    const download = tile('@a3').getByRole('button', { name: 'Download', exact: true })
    expect(await download.isDisabled()).toBe(true)
    await link.click()
    await page.keyboard.type('youtube.com/watch?v=abc123')
    expect(await link.inputValue()).toBe('youtube.com/watch?v=abc123')
    expect(await link.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await download.isEnabled()).toBe(true)
    expect(await input().textContent()).toBe('')
  })

  it('browses the library from @a4', async () => {
    await tile('@a4').getByRole('button', { name: 'Browse library', exact: true }).click()
    await page.getByLabel('Search the library').waitFor({ state: 'visible', timeout: 30_000 })
  })
})
