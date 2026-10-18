import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { seedMixedStatusCatalog } from './library-browse-fixture.js'
import { availablePort, record, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

const MCP_ROUNDTRIP_MS = 15_000

describe('Library in the chat composer', () => {
  let rootDir = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser
  let page: Page
  let client: Client
  let appUrl = ''
  let origin = ''
  let bookId = ''
  let notebookId = ''
  let otherBookId = ''
  let localImageId = ''
  let foreignImageId = ''
  let imageBytes: Buffer

  async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return resultValue(await client.callTool({ name, arguments: { book_id: bookId, notebook_id: notebookId, ...args } }))
  }

  async function cells(): Promise<Array<Record<string, unknown>>> {
    const notebook = record(await call('get_notebook'))
    return (Array.isArray(notebook?.cells) ? notebook.cells : [])
      .map(record).filter((cell): cell is Record<string, unknown> => cell !== null)
  }

  const picker = () => page.getByRole('region', { name: 'Choose library media', exact: true })
  const input = () => page.getByLabel('Videobook command input', { exact: true })

  async function openLibrary(): Promise<void> {
    await page.getByLabel('Open Library', { exact: true }).click()
    await picker().waitFor({ state: 'visible', timeout: MCP_ROUNDTRIP_MS })
    await expect.poll(() => picker().locator('.media-library-results').getAttribute('aria-busy'), { timeout: MCP_ROUNDTRIP_MS }).toBe('false')
  }

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-library-composer-'))
    const books = new BookManager({ libraryDir: join(rootDir, 'books') })
    await books.ready()
    const created = await books.create('library-target')
    const other = await books.create('library-source')
    if (!created.ok || !other.ok) throw new Error('Could not create the fixture books')
    bookId = created.value.bookId
    otherBookId = other.value.bookId
    const target = books.get(bookId)
    const source = books.get(otherBookId)
    if (!target.ok || !source.ok) throw new Error('Could not open the fixture books')
    await seedMixedStatusCatalog(source.value.engine, { ready: 26, error: 1, processing: 1 })
    imageBytes = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#48b26f' } }).png().toBuffer()
    for (const [engine, local] of [[target.value.engine, true], [source.value.engine, false]] as const) {
      const asset = await engine.artifacts.create({ kind: 'image', label: 'Shared picture label' })
      if (!asset.ok) throw new Error(asset.error.message)
      const saved = await engine.files.write(asset.value.artifactId, 'original.png', imageBytes)
      if (!saved.ok) throw new Error(saved.error.message)
      if (local) localImageId = asset.value.artifactId
      else foreignImageId = asset.value.artifactId
    }
    const videoPath = join(rootDir, 'preview.mp4')
    const audioPath = join(rootDir, 'preview.wav')
    await promisify(execFile)(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath])
    await promisify(execFile)(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-c:a', 'pcm_s16le', audioPath])
    for (const [kind, label, path] of [['video', 'Library clip', videoPath], ['audio', 'Library tone', audioPath]] as const) {
      const asset = await target.value.engine.artifacts.create({ kind, label })
      if (!asset.ok) throw new Error(asset.error.message)
      const saved = await target.value.engine.files.writeFromPath(asset.value.artifactId, kind === 'video' ? 'original.mp4' : 'original.wav', path)
      if (!saved.ok) throw new Error(saved.error.message)
      const metadata = await target.value.engine.metadata.artifacts.write(asset.value.artifactId, 'original', await probeVideo(path))
      if (!metadata.ok) throw new Error(metadata.error.message)
    }
    await books.close()
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    origin = `http://127.0.0.1:${mcpPort}`
    appUrl = `http://127.0.0.1:${vitePort}`
    const env = { ...process.env, PORT: String(mcpPort), VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'), VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime/app-state.json') }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'library-composer-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    const notebooks = await call('list_notebooks')
    notebookId = String(record(Array.isArray(notebooks) ? notebooks[0] : null)?.id ?? '')
    expect(notebookId).not.toBe('')
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
    })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
  }, 120_000)

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
    await input().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => page.getByLabel('Open Library', { exact: true }).isEnabled(), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
  })

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      const path = `/tmp/videobook-library-composer-${task.name.replace(/[^a-z0-9]+/giu, '-').slice(0, 90)}`
      await page.screenshot({ path: `${path}.png` })
      await writeFile(`${path}.json`, JSON.stringify({ errors: task.result.errors, body: await page.locator('body').innerText() }, null, 2))
    }
    await page.close()
    for (const cell of await cells()) await call('delete_notebook_cell', { cell_id: cell.id })
  })

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('keeps the notebook and draft visible while browsing all ready media and paging', async () => {
    await input().fill('Keep this draft')
    await openLibrary()
    expect(new URL(page.url()).pathname).toBe('/')
    expect(await page.getByLabel('Notebook canvas', { exact: true }).isVisible()).toBe(true)
    expect(await page.locator('dialog[open], [aria-modal="true"], .library-drop-zone').count()).toBe(0)
    expect(await picker().evaluate(element => Boolean(element.closest('.command-composer')))).toBe(true)
    expect(await picker().getByLabel('Search library', { exact: true }).evaluate(element => document.activeElement === element)).toBe(true)
    expect(await input().textContent()).toBe('Keep this draft')
    expect(await cells()).toEqual([])
    const titles = await picker().locator('.media-library-asset-copy strong').allTextContents()
    expect(titles).toContain('Library clip')
    expect(titles).toContain('Library tone')
    expect(titles).toContain('Shared picture label')
    expect(titles.some(title => /failed|processing/u.test(title))).toBe(false)
    expect(titles).toHaveLength(24)
    await picker().getByRole('button', { name: 'Load more', exact: true }).click()
    await expect.poll(() => picker().locator('.media-library-asset').count(), { timeout: MCP_ROUNDTRIP_MS }).toBe(30)
    await picker().getByLabel('Search library', { exact: true }).fill('Shared picture label')
    await picker().getByLabel('Search library', { exact: true }).press('Enter')
    await expect.poll(() => picker().locator('.media-library-asset').count(), { timeout: MCP_ROUNDTRIP_MS }).toBe(2)
    await picker().getByLabel('Search library', { exact: true }).press('Escape')
    await picker().waitFor({ state: 'hidden' })
    expect(await input().textContent()).toBe('Keep this draft')
    expect(await cells()).toEqual([])
  })

  it('places a local picture at @a4 only after selecting it', async () => {
    await page.getByRole('button', { name: 'Browse library', exact: true }).click()
    await picker().waitFor({ state: 'visible' })
    expect(await cells()).toEqual([])
    await picker().getByRole('button', { name: 'Use Shared picture label from library-target', exact: true }).click()
    await expect.poll(cells, { timeout: MCP_ROUNDTRIP_MS }).toEqual([expect.objectContaining({ type: 'image', slot: { row: 0, column: 3 }, output_artifact_id: localImageId })])
    await picker().waitFor({ state: 'hidden' })
  })

  it('copies the chosen foreign source without confusing matching labels', async () => {
    await openLibrary()
    await picker().getByRole('button', { name: 'Use Shared picture label from library-source', exact: true }).click()
    await expect.poll(async () => typeof (await cells())[0]?.output_artifact_id, { timeout: MCP_ROUNDTRIP_MS }).toBe('string')
    const cell = (await cells())[0]!
    expect(cell.type).toBe('image')
    expect(cell.output_artifact_id).not.toBe(localImageId)
    expect(cell.output_artifact_id).not.toBe(foreignImageId)
    const copied = await fetch(`${origin}/files/${bookId}/${String(cell.output_artifact_id)}/original.png`)
    expect(copied.status).toBe(200)
    expect(Buffer.from(await copied.arrayBuffer())).toEqual(imageBytes)
    const original = await fetch(`${origin}/files/${otherBookId}/${foreignImageId}/original.png`)
    expect(Buffer.from(await original.arrayBuffer())).toEqual(imageBytes)
  })

  it('places video and audio with their matching cell kinds', async () => {
    for (const [label, kind] of [['Library clip', 'video'], ['Library tone', 'audio']]) {
      await openLibrary()
      await picker().getByRole('button', { name: `Use ${label} from library-target`, exact: true }).click()
      await expect.poll(async () => (await cells()).some(cell => cell.type === kind && typeof cell.output_artifact_id === 'string'), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
      await picker().waitFor({ state: 'hidden' })
    }
    expect(await cells()).toHaveLength(2)
  })

  it('uploads from the picker into the starter square and closes after placement', async () => {
    await page.getByRole('button', { name: 'Browse library', exact: true }).click()
    await picker().waitFor({ state: 'visible' })
    await picker().locator('input[type="file"]').setInputFiles({ name: 'library-picture.png', mimeType: 'image/png', buffer: imageBytes })
    await expect.poll(cells, { timeout: MCP_ROUNDTRIP_MS }).toEqual([expect.objectContaining({ type: 'image', slot: { row: 0, column: 3 }, output_artifact_id: expect.any(String) })])
    await picker().waitFor({ state: 'hidden' })
  })

  it('keeps search and close controls usable on narrow screens and retires the old page', async () => {
    await page.goto(`${appUrl}/library`)
    await input().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => page.getByLabel('Open Library', { exact: true }).isEnabled(), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
    await openLibrary()
    for (const [width, height] of [[1440, 1000], [390, 844], [320, 740], [844, 390]]) {
      await page.setViewportSize({ width, height })
      const search = picker().getByLabel('Search library', { exact: true })
      await expect.poll(() => search.evaluate(element => {
        const box = element.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
      })).toBe(true)
      expect(await page.getByRole('button', { name: 'Collapse chat', exact: true }).isVisible()).toBe(true)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    if (process.env.LIBRARY_SCREENSHOT) await page.screenshot({ path: process.env.LIBRARY_SCREENSHOT })
    await page.getByRole('button', { name: 'Collapse chat', exact: true }).click()
    await picker().waitFor({ state: 'hidden' })
    expect(await page.locator('.library-drop-zone').count()).toBe(0)
    expect(await input().isVisible()).toBe(true)
    await openLibrary()
    expect(await cells()).toEqual([])
    await page.getByLabel('Open Jobs', { exact: true }).click()
    await openLibrary()
    expect(new URL(page.url()).pathname).toBe('/')
  })
})
