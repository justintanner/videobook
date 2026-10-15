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
import { availablePort, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

const exec = promisify(execFile)
type PostWire = { id: string; address: string; definition: { caption: string } }

describe('Dropbox upload review in the chat composer', () => {
  let root = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser | undefined
  let client: Client | undefined
  let page: Page
  let bookId = ''
  let notebookId = ''
  let sourceCellId = ''
  let post: PostWire
  const calls: string[] = []
  const errors: string[] = []
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(await client!.callTool({ name, arguments: { book_id: bookId, ...args } })) as T
  const review = () => page.getByRole('dialog', { name: 'Dropbox upload review', exact: true })
  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-post-dropbox-ui-'))
    const fixture = join(root, 'source.mp4')
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x160:rate=24:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture])
    const manager = new BookManager({ libraryDir: join(root, 'books') })
    const created = await manager.create('dropbox-ui')
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const found = manager.get(bookId)
    if (!found.ok) throw new Error(found.error.message)
    const engine = found.value.engine
    const source = await engine.artifacts.create({ kind: 'video', label: 'Umbrella cold open' })
    if (!source.ok) throw new Error(source.error.message)
    await engine.files.writeFromPath(source.value.artifactId, 'original.mp4', fixture)
    await registerMediaProbe(engine, source.value.artifactId, 'original.mp4', await probeVideo(fixture))
    const notebook = engine.notebooks.list()[0]!
    notebookId = notebook.id
    const cell = engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 0 }, outputArtifactId: source.value.artifactId })
    sourceCellId = cell.id
    await engine.notebooks.insertCell(notebook.id, cell)
    await manager.close()
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    const env = { ...process.env, NODE_ENV: 'test', DROPBOX_CLIENT_ID: '', PORT: String(port), VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json') }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'post-dropbox-ui', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    post = await call<PostWire>('create_post', { notebook_id: notebookId, source_cell_id: sourceCellId, platform: 'tiktok', caption: 'Draft caption' })
    const vitePort = await availablePort()
    const appUrl = `http://127.0.0.1:${vitePort}`
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

  it('opens a composer sheet for a Post address, edits the caption, explains the blocked upload and cancels without writing', async () => {
    await command(`/upload-post-to-dropbox ${post.address}`)
    await review().waitFor({ state: 'visible' })
    expect(await review().evaluate(element => Boolean(element.closest('.command-composer')))).toBe(true)
    await expect.poll(() => page.getByRole('dialog', { name: 'Actions', exact: true }).count()).toBe(0)
    expect(await review().getByText(post.address, { exact: true }).first().isVisible()).toBe(true)

    const caption = review().getByLabel('Caption', { exact: true })
    expect(await caption.inputValue()).toBe('Draft caption')
    await caption.fill('It only rains when you forget the umbrella.')
    expect(await review().getByLabel('Folder', { exact: true }).inputValue()).toMatch(/^\/Videobook\/dropbox-ui\/post-/u)

    await expect.poll(() => review().getByRole('alert').textContent(), { timeout: 15_000 }).toContain('DROPBOX_CLIENT_ID')
    expect(await review().getByRole('button', { name: /^Upload/ }).isDisabled()).toBe(true)
    expect(calls).toContain('dropbox_connect_status')

    await page.setViewportSize({ width: 390, height: 844 })
    expect(await review().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.setViewportSize({ width: 1440, height: 1000 })

    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })
    expect(calls).not.toContain('upload_post_to_dropbox')
    expect((await call<PostWire>('get_post', { post_cell_id: post.id })).definition.caption).toBe('Draft caption')

    await command('/upload-post-to-dropbox @a1')
    await expect.poll(() => page.getByText('@a1 is not a Post cell', { exact: false }).count(), { timeout: 10_000 }).toBeGreaterThan(0)
    expect(await review().count()).toBe(0)

    const catalog = await call<{ actions: Array<{ command: string; handler: { kind: string; action?: string } }> }>('list_workspace_actions')
    expect(catalog.actions.find(action => action.command === '/upload-post-to-dropbox')?.handler).toEqual({ kind: 'ui', action: 'open_post_dropbox' })
    expect(errors).toEqual([])
  }, 90_000)
})
