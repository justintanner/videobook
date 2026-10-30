import { execFile } from 'node:child_process'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { registerMediaProbe } from '../../server/src/notebook-media-ops.js'
import { extractVideoPoster } from '../../server/src/video-poster.js'
import { MANAGED_ENV_KEYS } from '../../server/src/env-secrets.js'
import { availablePort, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'
import type { PostView } from '../../server/src/posts/post-contract.js'

const exec = promisify(execFile)

describe('Post cells from clip to publication in the browser', () => {
  let root = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser | undefined
  let client: Client | undefined
  let page: Page
  let bookId = ''
  let sourceCellId = ''
  const errors: string[] = []
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(await client!.callTool({ name, arguments: { book_id: bookId, ...args } })) as T

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-post-ui-'))
    const fixture = join(root, 'clip.mp4')
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture])
    const manager = new BookManager({ libraryDir: join(root, 'books') })
    const created = await manager.create('publication-demo')
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const found = manager.get(bookId)
    if (!found.ok) throw new Error(found.error.message)
    const engine = found.value.engine
    const asset = await engine.artifacts.create('video', 'Skating dog')
    if (!asset.ok) throw new Error(asset.error.message)
    await engine.files.writeFromPath(asset.value.artifactId, 'original.mp4', fixture)
    await registerMediaProbe(engine, asset.value.artifactId, 'original.mp4', await probeVideo(fixture))
    await engine.files.write(asset.value.artifactId, 'original.jpg', await extractVideoPoster(fixture, 2))
    const notebook = engine.notebooks.list()[0]!
    const source = engine.notebooks.createCell({ type: 'video', slot: { row: 3, column: 1 }, outputArtifactId: asset.value.artifactId, label: 'Skating dog' })
    sourceCellId = source.id
    await engine.notebooks.insertCell(notebook.id, source)
    await manager.close()
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    const env = { ...process.env, ...Object.fromEntries(MANAGED_ENV_KEYS.map(key => [key, ''])), NODE_ENV: 'test', PORT: String(port), VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json'), VIDEOBOOK_ENV_PATH: join(root, '.env') }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'post-ui', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    const vitePort = await availablePort()
    const appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
  }, 90_000)

  afterEach(async () => {
    await mkdir('/tmp/videobook-post-evidence', { recursive: true })
    await page?.screenshot({ path: '/tmp/videobook-post-evidence/latest.png', fullPage: true })
  })

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (root) await rm(root, { recursive: true, force: true })
  }, 30_000)

  it('creates a Post from d2, saves a manual publication, records metrics and keeps results', async () => {
    const source = page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`)
    await source.click({ button: 'right', timeout: 30_000 })
    await page.getByRole('menuitem', { name: 'Post…', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'Post delivery', exact: true })
    await sheet.waitFor({ state: 'visible', timeout: 30_000 })
    expect(await sheet.getByRole('button', { name: 'Download', exact: true }).count()).toBe(1)
    await sheet.getByRole('button', { name: /Cancel/ }).click()
    await sheet.waitFor({ state: 'hidden' })
    const created = (await call<{ posts: PostView[] }>('list_posts')).posts
    expect(created).toHaveLength(1)
    const collapse = page.getByLabel('Collapse chat', { exact: true })
    if (await collapse.isVisible()) await collapse.click()
    await page.locator(`.react-flow__node[data-id="${created[0]!.id}"] .cell-node`).click({ button: 'right', timeout: 30_000 })
    await page.getByRole('menuitem', { name: 'Edit cell', exact: true }).click()
    const inspector = page.getByRole('region', { name: 'Post details' })
    await inspector.waitFor({ state: 'visible', timeout: 30_000 })
    await inspector.getByLabel('Instagram', { exact: true }).check()
    await inspector.getByLabel('Caption', { exact: true }).fill('A small dog, a big first trick')
    await inspector.getByLabel('Credits', { exact: true }).fill('Video by the studio')
    await inspector.getByRole('button', { name: 'Save draft', exact: true }).click()
    await expect.poll(async () => (await call<{ posts: PostView[] }>('list_posts')).posts[0]?.definition.caption, { timeout: 30_000 }).toBe('A small dog, a big first trick')
    await inspector.getByLabel('Post URL', { exact: true }).fill('https://www.instagram.com/reel/videobook-test/')
    await inspector.getByRole('button', { name: 'Save published link', exact: true }).click()
    await inspector.getByRole('link', { name: 'Open published post ↗' }).waitFor({ timeout: 30_000 })
    await inspector.getByText('Add manual observation', { exact: true }).click()
    await inspector.getByLabel('views', { exact: true }).fill('1200')
    await inspector.getByLabel('likes', { exact: true }).fill('85')
    await inspector.getByRole('button', { name: 'Save observation', exact: true }).click()
    await expect.poll(async () => (await call<{ posts: PostView[] }>('list_posts')).posts[0]?.runtime.metrics.length, { timeout: 30_000 }).toBe(1)
    await mkdir('/tmp/videobook-post-evidence', { recursive: true })
    await page.screenshot({ path: '/tmp/videobook-post-evidence/inspector.png', fullPage: true })
    await page.reload()
    expect((await call<{ posts: PostView[] }>('list_posts')).posts[0]?.runtime.metrics.at(-1)?.values.views).toBe(1200)
    expect(errors).toEqual([])
  }, 90_000)
})
