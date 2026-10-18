import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

describe('empty notebook start dock', () => {
  let rootDir = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser
  let client: Client
  let page: Page
  let appUrl = ''
  let bookId = ''
  let notebookId = ''

  async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return resultValue(await client.callTool({
      name,
      arguments: { book_id: bookId, notebook_id: notebookId, ...args },
    }))
  }

  function input(): Locator {
    return page.getByLabel('Videobook command input', { exact: true })
  }

  function dock(): Locator {
    return page.getByLabel('Start this notebook', { exact: true })
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
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-start-dock-e2e-'))
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
    client = new Client({ name: 'start-dock-e2e', version: '1.0.0' }, {
      capabilities: {},
      supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    const book = record(await call('create_book', { name: 'start-dock' }))
    bookId = String(book?.bookId ?? '')
    const notebooks = await call('list_notebooks')
    notebookId = String(record(Array.isArray(notebooks) ? notebooks[0] : null)?.id ?? '')
    expect(bookId).not.toBe('')
    expect(notebookId).not.toBe('')
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
  })

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      const path = `/tmp/videobook-start-dock-${task.name.replace(/[^a-z0-9]+/giu, '-').slice(0, 90)}`
      await page.screenshot({ path: `${path}.png` })
      await writeFile(`${path}.json`, JSON.stringify({ failures: task.result.errors, body: await page.locator('body').innerText() }, null, 2))
    }
    await page?.close()
    const notebook = record(await call('get_notebook'))
    for (const value of Array.isArray(notebook?.cells) ? notebook.cells : []) {
      await call('delete_notebook_cell', { cell_id: record(value)?.id })
    }
  })

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('keeps the whole grid visible and docks the start actions above the composer', async () => {
    await dock().waitFor({ state: 'visible' })
    expect(await page.locator('.canvas-welcome').count()).toBe(0)
    const squares = page.locator('.notebook-grid-square-label')
    await expect.poll(() => squares.count()).toBeGreaterThan(0)
    expect((await squares.first().textContent())?.trim()).toBe('@a1')

    const dockBox = await box(dock())
    const firstRow = await box(squares.first())
    const composer = await box(page.locator('.command-composer'))
    expect(dockBox.y).toBeGreaterThan(firstRow.y + firstRow.height)
    expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(composer.y)

    for (const label of ['Start with an image', 'Start with a video']) {
      const button = dock().getByLabel(label, { exact: true })
      expect(await button.locator('svg.lucide-plus').count()).toBe(1)
    }
    const link = dock().getByLabel('Clip link', { exact: true })
    const download = dock().getByRole('button', { name: 'Download clip' })
    expect(await download.isDisabled()).toBe(true)
    await link.fill('https://youtube.com/watch?v=abc123')
    expect(await download.isDisabled()).toBe(false)
    expect(await dock().getByRole('button', { name: 'Library' }).isEnabled()).toBe(true)
  })

  it('prefixes the toolbar quick-add buttons with a plus', async () => {
    for (const label of ['Add image', 'Add video']) {
      const button = toolbar().getByLabel(label, { exact: true })
      expect(await button.locator('svg.lucide-plus').count()).toBe(1)
      expect(await button.locator('svg.lucide-image, svg.lucide-video').count()).toBe(0)
    }
    expect((await toolbar().getByLabel('Add image', { exact: true }).textContent())?.trim()).toBe('Image')
    expect((await toolbar().getByLabel('Add video', { exact: true }).textContent())?.trim()).toBe('Video')
  })

  it('creates the first image cell from the dock and then gets out of the way', async () => {
    await dock().getByLabel('Start with an image', { exact: true }).click()
    await page.getByLabel('Empty image media slot', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => dock().count(), { timeout: 15_000 }).toBe(0)
    const notebook = record(await call('get_notebook'))
    const cells = (Array.isArray(notebook?.cells) ? notebook.cells : []).map(record)
    expect(cells.map(cell => cell?.type)).toEqual(['image'])
  })
})
