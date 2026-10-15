import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
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
const CAPTION = 'It only rains when you forget the umbrella.'

describe('Post delivery review in the chat composer', () => {
  let root = ''
  let icloudRoot = ''
  let fixture = ''
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
  const review = () => page.getByRole('dialog', { name: 'Post delivery', exact: true })
  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
  }
  const uploads = () => calls.filter(name => name === 'save_post_to_icloud').length

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-post-delivery-ui-'))
    fixture = join(root, 'source.mp4')
    const icloudParent = join(root, 'icloud')
    icloudRoot = join(icloudParent, 'Videobook')
    await mkdir(icloudParent)
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x160:rate=24:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture])
    const manager = new BookManager({ libraryDir: join(root, 'books') })
    const created = await manager.create('delivery-ui')
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
    const loose = await engine.artifacts.create({ kind: 'video', label: 'Unposted rain clip' })
    if (!loose.ok) throw new Error(loose.error.message)
    await engine.files.writeFromPath(loose.value.artifactId, 'original.mp4', fixture)
    await registerMediaProbe(engine, loose.value.artifactId, 'original.mp4', await probeVideo(fixture))
    await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({ type: 'video', slot: { row: 3, column: 1 }, outputArtifactId: loose.value.artifactId }))
    await manager.close()
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      DROPBOX_CLIENT_ID: '',
      OPENAI_API_KEY: '',
      PORT: String(port),
      VIDEOBOOK_LIBRARY_DIR: join(root, 'books'),
      VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json'),
      VIDEOBOOK_ICLOUD_DIR: icloudRoot,
    }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'post-delivery-ui', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
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

  it('saves a Post to the iPhone folder from the composer, treats a repeat as a no-op, and keeps Dropbox one click away', async () => {
    await command(`/save-post-to-icloud ${post.address}`)
    await review().waitFor({ state: 'visible' })
    expect(await review().evaluate(element => Boolean(element.closest('.command-composer')))).toBe(true)
    await expect.poll(() => page.getByRole('dialog', { name: 'Actions', exact: true }).count()).toBe(0)
    await expect.poll(() => review().getByRole('heading', { name: 'Save to iPhone', exact: true }).count()).toBe(1)
    expect(await review().getByRole('button', { name: 'iCloud · iPhone', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await review().getByRole('button', { name: 'Dropbox', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(await review().getByText(post.address, { exact: true }).first().isVisible()).toBe(true)

    const caption = review().getByLabel('Caption', { exact: true })
    expect(await caption.inputValue()).toBe('Draft caption')
    await caption.fill(CAPTION)
    const folder = await review().getByLabel('Folder', { exact: true }).inputValue()
    expect(folder).toMatch(/^delivery-ui\/post-/u)
    await expect.poll(() => review().getByRole('button', { name: /^Upload/ }).isEnabled(), { timeout: 15_000 }).toBe(true)
    expect(calls).toContain('icloud_status')
    expect(calls).not.toContain('save_post_to_icloud')
    expect(await review().textContent()).not.toContain('Uploading to iCloud')

    await review().getByRole('button', { name: /^Upload/ }).click()
    await expect.poll(() => review().getByText(/Saved .+ to iCloud/).count(), { timeout: 20_000 }).toBeGreaterThan(0)
    await expect.poll(() => calls.includes('post_icloud_sync_status'), { timeout: 15_000 }).toBe(true)
    expect(await review().textContent()).not.toContain('Uploading to iCloud')
    expect(await review().textContent()).not.toContain('On iCloud')
    const clipPath = join(icloudRoot, folder, 'clip.mp4')
    const captionPath = join(icloudRoot, folder, 'caption.txt')
    expect(await readFile(clipPath)).toEqual(await readFile(fixture))
    expect(await readFile(captionPath, 'utf8')).toBe(CAPTION)
    expect((await call<PostWire>('get_post', { post_cell_id: post.id })).definition.caption).toBe(CAPTION)
    const writtenAt = (await stat(clipPath)).mtimeNs

    await expect.poll(() => review().getByRole('button', { name: /^Upload/ }).isEnabled()).toBe(true)
    const beforeRepeat = uploads()
    await review().getByRole('button', { name: /^Upload/ }).click()
    await expect.poll(uploads, { timeout: 20_000 }).toBe(beforeRepeat + 1)
    await expect.poll(() => review().getByRole('button', { name: /^Upload/ }).isEnabled()).toBe(true)
    expect((await stat(clipPath)).mtimeNs).toBe(writtenAt)
    expect(await readFile(captionPath, 'utf8')).toBe(CAPTION)

    await review().getByRole('button', { name: 'Dropbox', exact: true }).click()
    await expect.poll(() => review().getByRole('heading', { name: 'Upload to Dropbox', exact: true }).count()).toBe(1)
    await expect.poll(() => review().getByRole('alert').textContent(), { timeout: 15_000 }).toContain('DROPBOX_CLIENT_ID')
    expect(await review().getByRole('button', { name: /^Upload/ }).isDisabled()).toBe(true)
    expect(calls).toContain('dropbox_connect_status')
    expect(calls).not.toContain('upload_post_to_dropbox')

    await page.setViewportSize({ width: 390, height: 844 })
    expect(await review().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.setViewportSize({ width: 1440, height: 1000 })

    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    await command(`/upload-post-to-dropbox ${post.address}`)
    await review().waitFor({ state: 'visible' })
    expect(await review().getByRole('button', { name: 'Dropbox', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await review().getByRole('button', { name: 'iCloud · iPhone', exact: true }).getAttribute('aria-pressed')).toBe('false')
    await expect.poll(() => review().getByRole('alert').textContent(), { timeout: 15_000 }).toContain('DROPBOX_CLIENT_ID')
    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    const postNode = () => page.locator(`.react-flow__node[data-id="${post.id}"]`)
    await expect.poll(() => postNode().getByText('iPhone', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await page.reload()
    await expect.poll(() => postNode().getByText('iPhone', { exact: true }).count(), { timeout: 30_000 }).toBe(1)

    const collapse = page.getByLabel('Collapse chat', { exact: true })
    if (await collapse.isVisible()) await collapse.click()
    const clear = page.getByLabel('Clear selection', { exact: true })
    if (await clear.isVisible()) await clear.click()
    await expect.poll(() => page.getByRole('region', { name: 'Post details' }).count()).toBe(0)
    const cell = postNode().locator('.cell-node')
    const beforeSelect = calls.filter(name => name === 'post_icloud_sync_status').length
    await cell.click({ button: 'right', timeout: 15_000 })
    const menuNames = await page.getByRole('menuitem').allTextContents()
    const iphoneIndex = menuNames.findIndex(name => name.includes('Save to iPhone'))
    const dropboxIndex = menuNames.findIndex(name => name.includes('Upload to Dropbox'))
    expect(iphoneIndex).toBeGreaterThanOrEqual(0)
    expect(dropboxIndex).toBeGreaterThan(iphoneIndex)
    await page.getByRole('menuitem', { name: 'Edit cell', exact: true }).click()
    const inspector = page.getByRole('region', { name: 'Post details' })
    await inspector.waitFor({ state: 'visible' })
    expect(await inspector.evaluate(root => [...root.querySelectorAll('button')].map(button => button.textContent?.trim()).filter(name => name === 'Save to iPhone' || name === 'Upload to Dropbox'))).toEqual(['Save to iPhone', 'Upload to Dropbox'])
    expect(await inspector.getByText('On iPhone · iCloud Drive › Videobook ›', { exact: false }).count()).toBe(1)
    expect(await inspector.getByText('Dropbox folder', { exact: false }).count()).toBe(0)
    const beforeInspector = uploads()
    await expect.poll(() => calls.filter(name => name === 'post_icloud_sync_status').length, { timeout: 15_000 }).toBeGreaterThan(beforeSelect)
    expect(await inspector.textContent()).not.toContain('Uploading to iCloud')
    expect(await inspector.textContent()).not.toContain('On iCloud')
    await inspector.getByRole('button', { name: 'Save to iPhone', exact: true }).click()
    await review().waitFor({ state: 'visible' })
    expect(await review().getByRole('button', { name: 'iCloud · iPhone', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(uploads()).toBe(beforeInspector)
    expect(calls).not.toContain('upload_post_to_dropbox')
    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    if (await collapse.isVisible()) await collapse.click()
    await cell.click({ button: 'right', timeout: 15_000 })
    const beforeDropbox = calls.filter(name => name === 'upload_post_to_dropbox').length
    await page.getByRole('menuitem', { name: 'Upload to Dropbox', exact: true }).click()
    await review().waitFor({ state: 'visible' })
    expect(await review().getByRole('button', { name: 'Dropbox', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(calls.filter(name => name === 'upload_post_to_dropbox').length).toBe(beforeDropbox)
    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    const beforeCreates = calls.filter(name => name === 'create_post').length
    await command('/save-post-to-icloud @a1')
    await review().waitFor({ state: 'visible' })
    expect(await review().getByText(post.address, { exact: true }).first().isVisible()).toBe(true)
    expect(calls.filter(name => name === 'create_post').length).toBe(beforeCreates)
    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    expect(calls).not.toContain('draft_post_copy')
    await command('/save-post-to-icloud @d2')
    await review().waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => calls.filter(name => name === 'draft_post_copy').length, { timeout: 15_000 }).toBe(1)
    await expect.poll(() => review().getByText('OPENAI_API_KEY is not set', { exact: false }).count(), { timeout: 15_000 }).toBeGreaterThan(0)
    expect(await review().getByRole('button', { name: 'X', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await review().getByRole('button', { name: 'EN', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await review().getByLabel('Regen with Astra', { exact: true }).isVisible()).toBe(true)
    await review().getByRole('button', { name: 'TH · ไทย', exact: true }).click()
    await expect.poll(() => calls.filter(name => name === 'draft_post_copy').length, { timeout: 15_000 }).toBe(2)
    expect(await review().getByRole('button', { name: 'TH · ไทย', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await review().getByLabel('Tags', { exact: true }).fill('rain day')
    await review().getByLabel('Tags', { exact: true }).press('Enter')
    expect(await review().getByRole('button', { name: 'Remove tag rain', exact: true }).count()).toBe(1)
    expect(await review().getByRole('button', { name: 'Remove tag day', exact: true }).count()).toBe(1)
    expect(calls.filter(name => name === 'create_post').length).toBe(beforeCreates + 1)
    const created = (await call<{ posts: PostWire[] }>('list_posts')).posts.filter(item => item.id !== post.id)
    expect(created).toHaveLength(1)
    expect(await review().getByText(created[0]!.address, { exact: true }).first().isVisible()).toBe(true)
    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    await command('/save-post-to-icloud @h8')
    await expect.poll(() => page.getByText('@h8 is not a Post or a clip', { exact: false }).count(), { timeout: 10_000 }).toBeGreaterThan(0)
    expect(await review().count()).toBe(0)

    const catalog = await call<{ actions: Array<{ command: string; handler: { kind: string; action?: string } }> }>('list_workspace_actions')
    expect(catalog.actions.find(action => action.command === '/save-post-to-icloud')?.handler).toEqual({ kind: 'ui', action: 'open_post_icloud' })
    expect(catalog.actions.find(action => action.command === '/upload-post-to-dropbox')?.handler).toEqual({ kind: 'ui', action: 'open_post_dropbox' })
    expect(errors).toEqual([])
  }, 120_000)
})
