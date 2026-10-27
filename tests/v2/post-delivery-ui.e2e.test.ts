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
type ObservedCall = { name: string; to?: string; postCellId?: string }
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
  let serverOrigin = ''
  let notebookId = ''
  let sourceCellId = ''
  let post: PostWire
  const calls: ObservedCall[] = []
  const errors: string[] = []
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(await client!.callTool({ name, arguments: { book_id: bookId, ...args } })) as T
  const review = () => page.getByRole('dialog', { name: 'Post delivery', exact: true })
  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
  }
  const count = (name: string, to?: string) => calls.filter(item => item.name === name && (to === undefined || item.to === to)).length
  const syncChecks = () => calls.filter(item => item.name === 'service_status' && item.postCellId === post.id).length
  const idle = () => expect.poll(() => page.locator('.command-send .busy-indicator').count(), { timeout: 20_000 }).toBe(0)

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
    serverOrigin = origin
    const env = {
      ...process.env,
      NODE_ENV: 'test',
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
    post = (await call<{ post: PostWire }>('post', { to: 'draft', notebook_id: notebookId, source_cell_id: sourceCellId, platform: 'tiktok', text: 'Draft caption' })).post
    const vitePort = await availablePort()
    const appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/mcp')) return
      calls.push(...toolCalls(request.postDataJSON()).map(item => ({
        name: item.name,
        to: typeof item.arguments.to === 'string' ? item.arguments.to : undefined,
        postCellId: typeof item.arguments.post_cell_id === 'string' ? item.arguments.post_cell_id : undefined,
      })))
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

  it('posts in one step to iPhone or a download from /post, switches to X and back, and reuses the clip Post', async () => {
    await command(`/post ${post.address}`)
    await review().waitFor({ state: 'visible' })
    expect(await review().evaluate(element => Boolean(element.closest('.command-composer')))).toBe(true)
    await expect.poll(() => page.getByRole('dialog', { name: 'Actions', exact: true }).count()).toBe(0)
    await expect.poll(() => review().getByRole('heading', { name: 'Save to iPhone', exact: true }).count()).toBe(1)
    expect(await review().getByRole('button', { name: 'iCloud · iPhone', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await review().getByRole('button', { name: 'Download', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(await review().getByRole('button', { name: 'X', exact: true }).count()).toBe(2)
    expect(await review().getByText(post.address, { exact: true }).first().isVisible()).toBe(true)

    const caption = review().getByLabel('Caption', { exact: true })
    expect(await caption.inputValue()).toBe('Draft caption')
    await caption.fill(CAPTION)
    const folder = await review().getByLabel('Folder', { exact: true }).inputValue()
    expect(folder).toMatch(/^delivery-ui\/post-/u)
    const apply = () => review().locator('.confirm-sheet-apply')
    await expect.poll(() => apply().isEnabled(), { timeout: 15_000 }).toBe(true)
    expect(await apply().textContent()).toContain('Save to iPhone')
    expect(count('service_status')).toBeGreaterThan(0)
    expect(count('post', 'icloud')).toBe(0)
    expect(await review().textContent()).not.toContain('Uploading to iCloud')

    await apply().click()
    await expect.poll(() => review().getByText(/Saved .+ to iCloud/).count(), { timeout: 20_000 }).toBeGreaterThan(0)
    await idle()
    expect(count('post', 'icloud')).toBe(1)
    expect(count('update_post')).toBe(0)
    await expect.poll(syncChecks, { timeout: 15_000 }).toBeGreaterThan(0)
    const clipPath = join(icloudRoot, folder, 'clip.mp4')
    const captionPath = join(icloudRoot, folder, 'caption.txt')
    expect(await readFile(clipPath)).toEqual(await readFile(fixture))
    expect(await readFile(captionPath, 'utf8')).toBe(CAPTION)
    expect((await call<{ posts: PostWire[] }>('list_posts', { post_cell_id: post.id })).posts[0]?.definition.caption).toBe(CAPTION)
    const writtenAt = (await stat(clipPath)).mtimeMs

    await expect.poll(() => apply().isEnabled()).toBe(true)
    await apply().click()
    await expect.poll(() => count('post', 'icloud'), { timeout: 20_000 }).toBe(2)
    await idle()
    await expect.poll(() => apply().isEnabled()).toBe(true)
    expect((await stat(clipPath)).mtimeMs).toBe(writtenAt)

    await review().getByRole('button', { name: 'Download', exact: true }).click()
    await expect.poll(() => review().getByRole('heading', { name: 'Download for manual upload', exact: true }).count()).toBe(1)
    expect(await review().getByRole('button', { name: 'Download', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await review().getByLabel('Folder', { exact: true }).count()).toBe(0)
    await expect.poll(() => apply().isEnabled(), { timeout: 15_000 }).toBe(true)
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), apply().click()])
    expect(count('post', 'download')).toBe(1)
    await expect.poll(() => review().getByText(/Downloaded .+ as /u).count(), { timeout: 20_000 }).toBeGreaterThan(0)
    await idle()
    const clipLink = review().locator('.post-delivery-downloads a').first()
    const filename = (await clipLink.textContent())?.trim() ?? ''
    expect(filename).toMatch(/^delivery-ui-post-.+\.mp4$/u)
    expect(download.suggestedFilename()).toBe(filename)
    const clipHref = await clipLink.getAttribute('href')
    expect(clipHref).toMatch(/^\/files\//u)
    const clip = await fetch(`${serverOrigin}${clipHref}`)
    expect(clip.status).toBe(200)
    expect(clip.headers.get('content-disposition')).toBe(`attachment; filename="${filename}"`)
    expect(Buffer.from(await clip.arrayBuffer())).toEqual(await readFile(fixture))
    const captionFile = await fetch(`${serverOrigin}${await review().getByRole('link', { name: 'caption.txt' }).getAttribute('href')}`)
    expect(captionFile.headers.get('content-disposition')).toMatch(/^attachment; filename="delivery-ui-post-.+\.txt"$/u)
    expect(await captionFile.text()).toBe(CAPTION)

    await review().getByRole('button', { name: 'X', exact: true }).last().click()
    const xReview = page.getByRole('dialog', { name: 'Chat action review', exact: true })
    await xReview.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await review().count()).toBe(0)
    expect(await xReview.getByRole('button', { name: 'X', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await xReview.getByLabel('Title', { exact: true }).inputValue()).toBe(CAPTION)
    await xReview.getByRole('button', { name: 'Download', exact: true }).click()
    await review().waitFor({ state: 'visible' })
    expect(await review().getByRole('button', { name: 'Download', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await review().getByText(post.address, { exact: true }).first().isVisible()).toBe(true)
    expect(count('post', 'x')).toBe(0)

    await page.setViewportSize({ width: 390, height: 844 })
    expect(await review().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    const postNode = () => page.locator(`.react-flow__node[data-id="${post.id}"]`)
    await expect.poll(() => postNode().getByText('iPhone', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => postNode().getByText('Downloaded', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await page.reload()
    await expect.poll(() => postNode().getByText('iPhone', { exact: true }).count(), { timeout: 30_000 }).toBe(1)

    const collapse = page.getByLabel('Collapse chat', { exact: true })
    if (await collapse.isVisible()) await collapse.click()
    const clear = page.getByLabel('Clear selection', { exact: true })
    if (await clear.isVisible()) await clear.click()
    await expect.poll(() => page.getByRole('region', { name: 'Post details' }).count()).toBe(0)
    const cell = postNode().locator('.cell-node')
    const beforeSelect = syncChecks()
    await cell.click({ button: 'right', timeout: 15_000 })
    const menuNames = await page.getByRole('menuitem').allTextContents()
    const iphoneIndex = menuNames.findIndex(name => name.includes('Save to iPhone'))
    const downloadIndex = menuNames.findIndex(name => name.trim() === 'Download')
    expect(iphoneIndex).toBeGreaterThanOrEqual(0)
    expect(downloadIndex).toBeGreaterThan(iphoneIndex)
    await page.getByRole('menuitem', { name: 'Edit cell', exact: true }).click()
    const inspector = page.getByRole('region', { name: 'Post details' })
    await inspector.waitFor({ state: 'visible' })
    expect(await inspector.evaluate(root => [...root.querySelectorAll('.post-delivery:not(.post-link-field) button')].map(button => button.textContent?.trim()))).toEqual(['Save to iPhone', 'Download', 'Post to X…'])
    expect(await inspector.getByRole('button', { name: 'Save to iPhone', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await inspector.getByRole('button', { name: 'Download', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(await inspector.getByText('On iPhone · iCloud Drive › Videobook ›', { exact: false }).count()).toBe(1)
    expect(await inspector.getByText('Downloaded for manual upload', { exact: true }).count()).toBe(1)
    expect(await inspector.getByRole('link', { name: filename, exact: true }).getAttribute('href')).toBe(clipHref)
    await expect.poll(syncChecks, { timeout: 15_000 }).toBeGreaterThan(beforeSelect)
    const beforeInspector = count('post')
    await inspector.getByRole('button', { name: 'Download', exact: true }).click()
    await review().waitFor({ state: 'visible' })
    expect(await review().getByRole('button', { name: 'Download', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(count('post')).toBe(beforeInspector)
    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    if (await collapse.isVisible()) await collapse.click()
    await cell.click({ button: 'right', timeout: 15_000 })
    await page.getByRole('menuitem', { name: 'Save to iPhone', exact: true }).click()
    await review().waitFor({ state: 'visible' })
    expect(await review().getByRole('button', { name: 'iCloud · iPhone', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(count('post')).toBe(beforeInspector)
    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    const beforeDrafts = count('post', 'draft')
    await command('/post @a1')
    await review().waitFor({ state: 'visible' })
    expect(await review().getByText(post.address, { exact: true }).first().isVisible()).toBe(true)
    expect(count('post', 'draft')).toBe(beforeDrafts)
    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    expect(count('draft_post_copy')).toBe(0)
    await command('/post @d2')
    await review().waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => count('draft_post_copy'), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => review().getByText('OPENAI_API_KEY is not set', { exact: false }).count(), { timeout: 15_000 }).toBeGreaterThan(0)
    expect(await review().getByRole('button', { name: 'TikTok', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await review().getByRole('button', { name: 'TH · ไทย', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await review().getByRole('button', { name: 'EN', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(await review().getByRole('button', { name: 'Remove tag fyp', exact: true }).count()).toBe(1)
    expect(await review().getByRole('button', { name: 'Remove tag bkk', exact: true }).count()).toBe(1)
    expect(await review().getByLabel('Regen with Astra', { exact: true }).isVisible()).toBe(true)
    await review().getByRole('button', { name: 'TH · ไทย', exact: true }).click()
    await expect.poll(() => count('draft_post_copy'), { timeout: 15_000 }).toBe(2)
    await review().getByLabel('Tags', { exact: true }).fill('rain day')
    await review().getByLabel('Tags', { exact: true }).press('Enter')
    expect(await review().getByRole('button', { name: 'Remove tag rain', exact: true }).count()).toBe(1)
    expect(await review().getByRole('button', { name: 'Remove tag day', exact: true }).count()).toBe(1)
    expect(count('post', 'draft')).toBe(beforeDrafts + 1)
    const created = (await call<{ posts: PostWire[] }>('list_posts')).posts.filter(item => item.id !== post.id)
    expect(created).toHaveLength(1)
    expect(await review().getByText(created[0]!.address, { exact: true }).first().isVisible()).toBe(true)
    await review().getByRole('button', { name: /Cancel/ }).click()
    await review().waitFor({ state: 'hidden' })

    await command('/post @h8')
    await expect.poll(() => page.getByText('@h8 is not a Post or a clip', { exact: false }).count(), { timeout: 10_000 }).toBeGreaterThan(0)
    expect(await review().count()).toBe(0)

    const catalog = await call<{ actions: Array<{ command: string; handler: { kind: string; action?: string } }> }>('list_workspace_actions', { detail: 'full' })
    expect(catalog.actions.find(action => action.command === '/post')?.handler).toEqual({ kind: 'ui', action: 'open_post_composer' })
    expect(catalog.actions.some(action => ['/save-post-to-icloud', '/upload-post-to-dropbox'].includes(action.command))).toBe(false)
    expect(errors).toEqual([])
  }, 180_000)
})
