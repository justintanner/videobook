import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Locator, Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { graphicsDocumentFromLayers } from '../../server/src/graphics/model.js'
import { saveGraphicsTemplate } from '../../server/src/graphics/templates.js'
import { registerMediaProbe } from '../../server/src/notebook-media-ops.js'
import { extractVideoPoster } from '../../server/src/video-poster.js'
import { testBudget } from '../../server/src/test-budget.js'
import { availablePort, record, requestBody, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

const exec = promisify(execFile)
const SHOTS = process.env.VIDEOBOOK_E2E_SHOTS ?? null
const WIDTH = 720
const HEIGHT = 1280
const DURATION = 3
const THAI_TITLE = 'ติดไฟแดงยังไงให้เท่ได้ขนาดนี้'
const ENGLISH_LINE = 'How can you look this cool?'
const CREDIT = 'TikTok/@pomkondeena'
const TIKTOK_SOURCE = {
  origin: 'download',
  source_url: 'https://www.tiktok.com/@pomkondeena/video/7432100000000000000',
  webpage_url: 'https://www.tiktok.com/@pomkondeena/video/7432100000000000000',
  platform: 'TikTok',
  uploader: 'pomkondeena',
}

type Box = { x: number; y: number; width: number; height: number }
type Item = { id: string; slot: string | null; text: string; accent: string; icon: string | null }
type Layer = {
  id: string
  kind: string
  name: string
  visible: boolean
  opacity: number
  artifactId?: string
  edge?: string
  align?: string
  size?: number
  position?: { anchor: string; x: number; y: number; space: string }
  items?: Item[]
}
type Read = {
  watermark?: { platform: string; template_id: string | null; template_name: string | null } | null
  saved: boolean
  revision: string
  document: { layers: Layer[] }
  templates: Array<{ id: string; name: string; document: { layers: Layer[] }; missing_layer_ids: string[] }>
  default_template_id: string
  images: Record<string, { url: string | null }>
  render: { request_id: string; status: string; output_asset_id: string; address: string | null; error: string | null } | null
  burned: { request_id: string; output: string } | null
  source: { source_hash: string }
}
type NotebookWire = { cells: Array<{ id: string; output_artifact_id?: string; slot: { row: number; column: number } }> }
type Size = { width: number; height: number }
type Point = { x: number; y: number }

const PORTRAIT: Size = { width: WIDTH, height: HEIGHT }
const SQUARE: Size = { width: 720, height: 720 }
const WIDE: Size = { width: 1280, height: 720 }
const WIDE_DURATION = 6

function slotText(read: Read, slot: string): string | undefined {
  return read.document.layers.flatMap((layer) => layer.items ?? []).find((item) => item.slot === slot)?.text
}

function parseBox(value: string | null): Box {
  const [x, y, width, height] = (value ?? '').split(',').map(Number)
  return { x, y, width, height }
}

describe('graphics editor in the composer', () => {
  let root = ''
  let origin = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser | undefined
  let client: Client | undefined
  let page: Page
  let appUrl = ''
  let bookId = ''
  let notebookId = ''
  let sourceId = ''
  let secondId = ''
  let thirdId = ''
  let thirdCellId = ''
  let logoId = ''
  let logoCellId = ''
  let kitLogoId = ''
  let squareId = ''
  let wideId = ''
  let watermarkId = ''
  const renders: Record<string, unknown>[] = []
  const errors: string[] = []
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(await client!.callTool({ name, arguments: { book_id: bookId, ...args } })) as T
  const read = (assetId = sourceId) => call<Read>('video_graphics', { asset_id: assetId })
  const sheet = () => page.getByRole('dialog', { name: 'Graphics editor', exact: true })
  const field = (label: string) => sheet().getByLabel(label, { exact: true })
  const saved = () => expect.poll(() => sheet().locator('.graphics-save-state').textContent(), { timeout: testBudget(15_000) }).toBe('Saved')
  const itemBox = async (slot: string) => {
    const item = sheet().locator(`.graphics-item-box[data-slot="${slot}"]`).first()
    await expect.poll(async () => parseBox(await item.getAttribute('data-box')).height, { timeout: testBudget(15_000) }).toBeGreaterThan(0)
    return parseBox(await item.getAttribute('data-box'))
  }
  const command = async (text: string) => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
    await input.fill(text)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
  }
  const shot = async (name: string) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  }

  async function frame(assetId: string, seconds: number, size: Size = PORTRAIT): Promise<Buffer> {
    const path = join(root, `${assetId}-${Date.now()}.mp4`)
    const response = await fetch(`${origin}/files/${bookId}/${assetId}/original.mp4`)
    expect(response.status).toBe(200)
    await writeFile(path, Buffer.from(await response.arrayBuffer()))
    const { stdout } = await exec(FFMPEG, ['-v', 'error', '-ss', seconds.toFixed(3), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: size.width * size.height * 4 })
    return stdout
  }

  function inkBox(pixels: Buffer, band: Box, tolerance: number, size: Size = PORTRAIT): Box & { count: number } {
    const box = { minX: size.width, maxX: -1, minY: size.height, maxY: -1, count: 0 }
    const top = Math.max(0, Math.floor(band.y - tolerance))
    const bottom = Math.min(size.height, Math.ceil(band.y + band.height + tolerance))
    for (let y = top; y < bottom; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const offset = (y * size.width + x) * 3
        if (pixels[offset] < 225 || pixels[offset + 1] < 225 || pixels[offset + 2] < 225) continue
        box.count += 1
        box.minX = Math.min(box.minX, x)
        box.maxX = Math.max(box.maxX, x)
        box.minY = Math.min(box.minY, y)
        box.maxY = Math.max(box.maxY, y)
      }
    }
    return { x: box.minX, y: box.minY, width: box.maxX - box.minX + 1, height: box.maxY - box.minY + 1, count: box.count }
  }

  async function video(path: string, label: string, original?: Record<string, unknown>, size: Size = PORTRAIT, duration = DURATION) {
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x2060a0:s=${size.width}x${size.height}:r=30:d=${duration}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path])
    return { path, label, original, duration }
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-graphics-ui-'))
    const manager = new BookManager({ libraryDir: join(root, 'books') })
    const created = await manager.create('graphics-ui')
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const found = manager.get(bookId)
    if (!found.ok) throw new Error(found.error.message)
    const engine = found.value.engine
    const fixtures = [
      await video(join(root, 'red-light.mp4'), 'Red light', TIKTOK_SOURCE),
      await video(join(root, 'second.mp4'), 'Second take'),
      await video(join(root, 'third.mp4'), 'Third take'),
      await video(join(root, 'square.mp4'), 'Square take', undefined, SQUARE),
      await video(join(root, 'wide.mp4'), 'Wide take', undefined, WIDE, WIDE_DURATION),
      await video(join(root, 'watermark.mp4'), 'Watermark take'),
    ]
    const ids: string[] = []
    for (const fixture of fixtures) {
      const artifact = await engine.artifacts.create({ kind: 'video', label: fixture.label })
      if (!artifact.ok) throw new Error(artifact.error.message)
      await engine.files.writeFromPath(artifact.value.artifactId, 'original.mp4', fixture.path)
      await registerMediaProbe(engine, artifact.value.artifactId, 'original.mp4', await probeVideo(fixture.path))
      if (fixture.original) {
        const current = await engine.metadata.artifacts.read<Record<string, unknown>>(artifact.value.artifactId, 'original')
        await engine.metadata.artifacts.write(artifact.value.artifactId, 'original', { ...(current.ok ? current.value : {}), ...fixture.original })
      }
      await engine.files.write(artifact.value.artifactId, 'original.jpg', await extractVideoPoster(fixture.path, fixture.duration))
      ids.push(artifact.value.artifactId)
    }
    ;[sourceId, secondId, thirdId, squareId, wideId, watermarkId] = ids
    const logo = await engine.artifacts.create({ kind: 'image', label: 'Logo' })
    if (!logo.ok) throw new Error(logo.error.message)
    logoId = logo.value.artifactId
    await engine.files.write(logoId, 'original.png', await sharp({ create: { width: 120, height: 60, channels: 4, background: '#E11D48' } }).png().toBuffer())
    await engine.metadata.artifacts.write(logoId, 'original', { origin: 'upload', width: 120, height: 60 })
    const notebook = engine.notebooks.list()[0]!
    notebookId = notebook.id
    await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 0 }, outputArtifactId: sourceId }))
    await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 1 }, outputArtifactId: secondId }))
    const thirdCell = engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 2 }, outputArtifactId: thirdId })
    thirdCellId = thirdCell.id
    await engine.notebooks.insertCell(notebook.id, thirdCell)
    await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 3 }, outputArtifactId: squareId }))
    await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 4 }, outputArtifactId: wideId }))
    await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({ type: 'video', slot: { row: 1, column: 2 }, outputArtifactId: watermarkId }))
    const logoCell = engine.notebooks.createCell({ type: 'image', slot: { row: 1, column: 1 }, outputArtifactId: logoId })
    logoCellId = logoCell.id
    await engine.notebooks.insertCell(notebook.id, logoCell)
    const kit = await manager.create('brand-kit')
    if (!kit.ok) throw new Error(kit.error.message)
    const kitBook = manager.get(kit.value.bookId)
    if (!kitBook.ok) throw new Error(kitBook.error.message)
    const kitLogo = await kitBook.value.engine.artifacts.create({ kind: 'image', label: 'Kit logo' })
    if (!kitLogo.ok) throw new Error(kitLogo.error.message)
    kitLogoId = kitLogo.value.artifactId
    await kitBook.value.engine.files.write(kitLogoId, 'original.png', await sharp({ create: { width: 120, height: 60, channels: 4, background: '#22C55E' } }).png().toBuffer())
    await kitBook.value.engine.metadata.artifacts.write(kitLogoId, 'original', { origin: 'upload', width: 120, height: 60 })
    await saveGraphicsTemplate(kitBook.value.engine, {
      name: 'Brand kit',
      document: graphicsDocumentFromLayers([
        { kind: 'image', name: 'Kit logo', artifactId: kitLogoId, position: { anchor: 'top-right', x: 1, y: 0, space: 'safe' }, size: 0.2 },
        { kind: 'text', name: 'Kit title', position: { anchor: 'bottom-left', x: 0, y: 1, space: 'safe' }, align: 'left', items: [{ slot: 'headline', text: '', size: 0.07 }] },
      ]),
    })
    await manager.close()
    const port = await availablePort()
    origin = `http://127.0.0.1:${port}`
    const env = { ...process.env, NODE_ENV: 'test', OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '', PORT: String(port), VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json') }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'graphics-ui', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    const vitePort = await availablePort()
    appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/mcp')) return
      renders.push(...toolCalls(request.postDataJSON()).filter(item => item.name === 'video_graphics' && item.arguments.op === 'render').map(item => item.arguments))
    })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl, { timeout: testBudget(60_000) })
  }, testBudget(120_000))

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (root) await rm(root, { recursive: true, force: true })
  }, 30_000)

  it('opens the default look, previews a big Thai title over an English line, autosaves, undoes and resolves a conflict', async () => {
    await command('/osg @a1')
    await sheet().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => field('Headline').isEnabled(), { timeout: 30_000 }).toBe(true)
    const fresh = await read()
    expect(fresh.saved).toBe(false)
    expect(fresh.document.layers.map((layer) => layer.kind)).toEqual(['scrim', 'text', 'text'])
    expect(slotText(fresh, 'handle')).toBeTruthy()
    expect(slotText(fresh, 'headline')).toBe('')
    const stage = sheet().locator('.graphics-stage')
    const stageBox = await stage.boundingBox()
    expect(Math.abs(stageBox!.width / stageBox!.height - WIDTH / HEIGHT)).toBeLessThan(0.02)

    await field('Headline').fill(THAI_TITLE)
    await field('Second line').fill(ENGLISH_LINE)
    await saved()
    expect(slotText(await read(), 'headline')).toBe(THAI_TITLE)
    const title = await itemBox('headline')
    const line = await itemBox('secondary')
    expect(title.height).toBeGreaterThan(line.height * 1.5)
    expect(line.y).toBeGreaterThanOrEqual(title.y + title.height - 1)
    await shot('graphics-default-look')

    await sheet().getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => field('Second line').inputValue()).toBe('')
    await sheet().getByRole('button', { name: 'Redo', exact: true }).click()
    await expect.poll(() => field('Second line').inputValue()).toBe(ENGLISH_LINE)
    await saved()

    const current = await read()
    await call('video_graphics', { asset_id: sourceId, op: 'update', expected_revision: current.revision, edits: [{ op: 'set_slot_text', slot: 'secondary', text: 'Changed elsewhere' }] })
    await field('Headline').fill(`${THAI_TITLE}!`)
    await expect.poll(() => sheet().locator('.graphics-save-state').textContent(), { timeout: testBudget(15_000) }).toBe('Changed elsewhere')
    await sheet().getByRole('button', { name: 'Reload', exact: true }).click()
    await expect.poll(() => field('Second line').inputValue()).toBe('Changed elsewhere')
    expect(await field('Headline').inputValue()).toBe(THAI_TITLE)
    await field('Second line').fill(ENGLISH_LINE)
    await saved()
    expect(errors).toEqual([])
  })

  it('keeps the typed headline when a starter is applied and fills the credit from the download', async () => {
    await expect.poll(() => field('Headline').inputValue()).toBe(THAI_TITLE)
    await sheet().getByRole('button', { name: 'Lower third', exact: true }).click()
    await expect.poll(() => field('Headline').inputValue()).toBe(THAI_TITLE)
    await expect.poll(() => field('Credit').inputValue()).toBe(CREDIT)
    await field('Credit').fill('')
    await sheet().getByRole('button', { name: `Use ${CREDIT}`, exact: true }).click()
    await expect.poll(() => field('Credit').inputValue()).toBe(CREDIT)
    await saved()
    expect(slotText(await read(), 'credit')).toBe(CREDIT)
    await sheet().getByRole('button', { name: /^Close/ }).click()
    await sheet().waitFor({ state: 'hidden', timeout: 10_000 })
  })

  it('opens from /graphics and /overlay, adds a named image once, and leaves set_video_overlay as a tool', async () => {
    await command('/graphics @a1')
    await expect.poll(() => field('Headline').inputValue(), { timeout: 30_000 }).toBe(THAI_TITLE)
    await sheet().getByRole('button', { name: /^Close/ }).click()
    await command('/overlay @a1 @b2')
    await sheet().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => (await read()).document.layers.filter((layer) => layer.kind === 'image' && layer.artifactId === logoId).length, { timeout: testBudget(15_000) }).toBe(1)
    await saved()
    await sheet().getByRole('button', { name: /^Close/ }).click()
    await command('/overlay @a1 @b2')
    await sheet().waitFor({ state: 'visible', timeout: 30_000 })
    await saved()
    expect((await read()).document.layers.filter((layer) => layer.kind === 'image')).toHaveLength(1)
    expect(await page.getByRole('dialog', { name: /overlay/i }).count()).toBe(0)
    const overlay = await client!.callTool({ name: 'set_video_overlay', arguments: { book_id: bookId, asset_id: secondId, osg_asset_id: logoId, osg_position: 'top-right', osg_size: 'small' } })
    expect(overlay.isError).not.toBe(true)
  })

  it('renders a new connected cell whose headline sits where the preview drew it', async () => {
    await expect.poll(() => field('Headline').inputValue()).toBe(THAI_TITLE)
    const previewed = await itemBox('headline')
    const sourceHash = (await read()).source.source_hash
    await sheet().getByRole('button', { name: /^Render/ }).click()
    await sheet().waitFor({ state: 'hidden', timeout: 30_000 })
    expect(renders.at(-1)).toMatchObject({ op: 'render', output: 'new', asset_id: sourceId })
    await expect.poll(async () => (await read()).render?.status, { timeout: testBudget(180_000) }).toBe('completed')
    const render = (await read()).render!
    expect(render.address).toBe('@b1')
    const notebook = await call<NotebookWire>('get_notebook', { notebook_id: notebookId })
    expect(notebook.cells.find((cell) => cell.output_artifact_id === render.output_asset_id)?.slot).toEqual({ row: 1, column: 0 })
    expect((await read()).source.source_hash).toBe(sourceHash)

    const tolerance = Math.min(WIDTH, HEIGHT) * 0.01
    const ink = inkBox(await frame(render.output_asset_id, 1.5), previewed, tolerance)
    expect(ink.count).toBeGreaterThan(300)
    expect(Math.abs(ink.x - previewed.x)).toBeLessThanOrEqual(tolerance)
    expect(ink.y).toBeGreaterThanOrEqual(previewed.y - tolerance)
    expect(ink.y + ink.height).toBeLessThanOrEqual(previewed.y + previewed.height + tolerance)
    expect(ink.x + ink.width).toBeLessThanOrEqual(previewed.x + previewed.width + tolerance)
    expect(ink.width).toBeGreaterThan(previewed.width * 0.6)
    expect((await read(render.output_asset_id)).burned).toMatchObject({ output: 'new' })
  })

  it('burns the graphics into a video in place with the replace output', async () => {
    await command('/osg @a2')
    await sheet().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => field('Headline').isEnabled(), { timeout: 30_000 }).toBe(true)
    await field('Headline').fill('IN PLACE')
    await saved()
    const before = (await read(secondId)).source.source_hash
    await sheet().getByRole('group', { name: 'Render output', exact: true }).getByRole('button', { name: 'Replace video', exact: true }).click()
    await sheet().getByRole('button', { name: /^Render/ }).click()
    await sheet().waitFor({ state: 'hidden', timeout: 30_000 })
    expect(renders.at(-1)).toMatchObject({ op: 'render', output: 'replace', asset_id: secondId })
    await expect.poll(async () => (await read(secondId)).burned?.output ?? null, { timeout: testBudget(180_000) }).toBe('replace')
    await expect.poll(async () => (await read(secondId)).source.source_hash, { timeout: testBudget(60_000) }).not.toBe(before)
    expect((await read(secondId)).saved).toBe(false)
    expect((await call<NotebookWire>('get_notebook', { notebook_id: notebookId })).cells).toHaveLength(8)
    expect(errors).toEqual([])
  })

  it('opens from the cell menu and the media dock for videos only', async () => {
    const cell = (id: string) => page.locator(`.react-flow__node[data-id="${id}"] .cell-node`)
    await cell(thirdCellId).click({ button: 'right', timeout: 30_000 })
    await page.getByRole('menuitem', { name: 'Graphics', exact: true }).click()
    await sheet().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => field('Headline').isEnabled(), { timeout: 30_000 }).toBe(true)
    expect(await sheet().textContent()).toContain('Third take')
    await sheet().getByRole('button', { name: /^Close/ }).click()
    await sheet().waitFor({ state: 'hidden', timeout: 10_000 })
    await cell(logoCellId).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open media', exact: true }).waitFor()
    expect(await page.getByRole('menuitem', { name: 'Graphics', exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')

    const dock = page.locator('.composer-notebook-dock.inspector')
    await cell(thirdCellId).click({ position: { x: 20, y: 20 } })
    await dock.getByRole('button', { name: 'Open graphics for @a3', exact: true }).click()
    await sheet().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => field('Headline').isEnabled(), { timeout: 30_000 }).toBe(true)
    expect(await sheet().textContent()).toContain('Third take')
    await sheet().getByRole('button', { name: /^Close/ }).click()
    await sheet().waitFor({ state: 'hidden', timeout: 10_000 })
    await cell(logoCellId).click({ position: { x: 20, y: 20 } })
    await dock.getByRole('region', { name: 'Media actions' }).getByRole('button', { name: 'Copy image', exact: true }).waitFor()
    expect(await dock.getByRole('button', { name: /^Open graphics/ }).count()).toBe(0)
    expect(errors).toEqual([])
  })

  it('rebuilds the reference frame from the layer list and inspector, and every change previews, autosaves and undoes', async () => {
    const layers = sheet().getByRole('region', { name: 'Layers' })
    const layer = async (name: string) => (await read(thirdId)).document.layers.find((entry) => entry.name === name)
    const box = async (layerId: string) => parseBox(await sheet().locator(`.graphics-layer-box[data-layer-id="${layerId}"]`).getAttribute('data-box'))
    const undo = () => sheet().getByRole('button', { name: 'Undo', exact: true }).click()

    await command('/osg @a3')
    await sheet().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => field('Headline').isEnabled(), { timeout: 30_000 }).toBe(true)
    expect((await read(thirdId)).document.layers.map((entry) => entry.name)).toEqual(['Shade', 'Title', 'Handle'])

    await layers.getByRole('button', { name: 'Select layer Handle', exact: true }).click()
    await layers.getByRole('button', { name: 'Delete Handle', exact: true }).click()
    await layers.getByRole('button', { name: 'Select layer Title', exact: true }).click()
    await sheet().getByLabel('Item text', { exact: true }).fill('How can you look this cool while waiting at a red light?')
    await sheet().getByRole('button', { name: 'Edit item 2, Second line', exact: true }).click()
    await sheet().getByLabel('Item text', { exact: true }).fill(THAI_TITLE)
    await sheet().getByRole('button', { name: 'Add text item', exact: true }).click()
    await sheet().getByLabel('Item text', { exact: true }).fill(CREDIT)
    await sheet().getByLabel('Slot', { exact: true }).selectOption('credit')
    await sheet().getByLabel('Icon', { exact: true }).selectOption('camera')
    await layers.getByRole('button', { name: 'Add image layer', exact: true }).click()
    await sheet().getByRole('group', { name: 'Choose an image', exact: true }).getByRole('button', { name: '@b2 Logo', exact: true }).click()
    await saved()

    const rebuilt = (await read(thirdId)).document.layers
    expect(rebuilt.map((entry) => entry.kind)).toEqual(['scrim', 'text', 'image'])
    expect(rebuilt[0]).toMatchObject({ edge: 'bottom' })
    expect(rebuilt[1]!.items).toMatchObject([
      { slot: 'headline', text: 'How can you look this cool while waiting at a red light?', accent: 'brush' },
      { slot: 'secondary', text: THAI_TITLE },
      { slot: 'credit', text: CREDIT, icon: 'camera' },
    ])
    expect(rebuilt[2]).toMatchObject({ kind: 'image', name: 'Logo', artifactId: logoId, position: { anchor: 'top-left', x: 0, y: 0, space: 'safe' } })
    const logo = rebuilt[2]!
    await expect.poll(async () => (await box(logo.id)).width, { timeout: testBudget(15_000) }).toBeGreaterThan(0)
    const logoBox = await box(logo.id)
    expect(logoBox.x).toBeLessThan(WIDTH / 3)
    expect(logoBox.y).toBeLessThan(HEIGHT / 4)
    const credit = await itemBox('credit')
    expect(credit.y).toBeGreaterThan((await itemBox('secondary')).y)
    await shot('graphics-reference-frame')

    await layers.getByRole('button', { name: 'Select layer Title', exact: true }).click()
    await sheet().getByRole('group', { name: 'Align', exact: true }).getByRole('button', { name: 'Center', exact: true }).click()
    await expect.poll(async () => (await itemBox('credit')).x).toBeGreaterThan(credit.x)
    await saved()
    expect((await layer('Title'))?.align).toBe('center')
    await undo()
    await expect.poll(async () => (await itemBox('credit')).x).toBe(credit.x)
    await saved()
    expect((await layer('Title'))?.align).toBe('left')

    await layers.getByRole('button', { name: 'Select layer Logo', exact: true }).click()
    const width = sheet().getByLabel('Width', { exact: true })
    await width.focus()
    await width.press('End')
    await expect.poll(async () => (await box(logo.id)).width).toBeGreaterThan(logoBox.width * 2)
    await saved()
    expect((await layer('Logo'))?.size).toBe(1)
    await undo()
    await expect.poll(async () => (await box(logo.id)).width).toBe(logoBox.width)
    await saved()

    await layers.getByRole('button', { name: 'Hide Logo', exact: true }).click()
    await expect.poll(() => sheet().locator(`.graphics-layer-box[data-layer-id="${logo.id}"]`).count()).toBe(0)
    await saved()
    expect((await layer('Logo'))?.visible).toBe(false)
    await layers.getByRole('button', { name: 'Show Logo', exact: true }).click()
    await layers.getByRole('button', { name: 'Duplicate Logo', exact: true }).click()
    await layers.getByRole('button', { name: 'Delete Logo copy', exact: true }).click()
    await layers.getByRole('button', { name: 'Select layer Shade', exact: true }).click()
    await layers.getByRole('button', { name: 'Move Shade up', exact: true }).click()
    await saved()
    expect((await read(thirdId)).document.layers.map((entry) => entry.name)).toEqual(['Title', 'Shade', 'Logo'])
    await undo()
    await layers.getByRole('button', { name: 'Select layer Logo', exact: true }).click()
    await layers.getByRole('button', { name: 'Rename Logo', exact: true }).click()
    await layers.getByLabel('Name of Logo', { exact: true }).fill('Brand logo')
    await layers.getByLabel('Name of Logo', { exact: true }).press('Enter')
    await saved()
    const final = (await read(thirdId)).document.layers
    expect(final.map((entry) => [entry.name, entry.visible])).toEqual([['Shade', true], ['Title', true], ['Brand logo', true]])
    await sheet().getByRole('button', { name: /^Close/ }).click()
    await sheet().waitFor({ state: 'hidden', timeout: 10_000 })
    expect(errors).toEqual([])
  })

  it('opens from typed chat with the headline filled and renders nothing until Render is pressed', async () => {
    const typed = 'add a headline saying Red light legends to @a3'
    const rendersBefore = renders.length
    const plan = {
      kind: 'chat-action-plan',
      planId: crypto.randomUUID(),
      bookId,
      prompt: typed,
      routedTool: 'show_graphics',
      tool: 'show_graphics',
      params: { asset_id: thirdId, cell_id: thirdCellId, headline: 'Red light legends' },
      message: 'Opening the graphics editor for @a3',
      summary: 'Opening the graphics editor for @a3',
      effect: 'view',
      confirmation: { required: false, reason: 'Opening a view changes nothing in the book' },
    }
    await page.route('**/mcp', async (route) => {
      const body = await requestBody(route)
      const envelope = (Array.isArray(body) ? body : [body]).map(record).find((entry) => {
        const params = record(entry?.params)
        return entry?.method === 'tools/call' && params?.name === 'chat' && String(record(params.arguments)?.prompt ?? '').includes('Red light legends')
      })
      if (!envelope) return route.continue()
      const response = { jsonrpc: '2.0', id: envelope.id, result: { resultType: 'complete', content: [{ type: 'text', text: JSON.stringify(plan) }], isError: false } }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? [response] : response) })
    })
    try {
      await command(typed)
      await sheet().waitFor({ state: 'visible', timeout: 30_000 })
      await expect.poll(() => field('Headline').inputValue(), { timeout: 30_000 }).toBe('Red light legends')
      await saved()
      const current = await read(thirdId)
      expect(slotText(current, 'headline')).toBe('Red light legends')
      expect(slotText(current, 'secondary')).toBe(THAI_TITLE)
      expect(current.render).toBeNull()
      expect(current.burned).toBeNull()
      expect(renders.length).toBe(rendersBefore)
      await sheet().getByRole('button', { name: /^Close/ }).click()
      await sheet().waitFor({ state: 'hidden', timeout: 10_000 })
      expect((await read(thirdId)).render).toBeNull()
    } finally {
      await page.unroute('**/mcp')
    }
    expect(errors).toEqual([])
  })

  const layerBox = (name: string) => sheet().locator(`.graphics-layer-box[aria-label="Select ${name}"]`)
  const boxOf = async (locator: Locator) => parseBox(await locator.getAttribute('data-box'))
  const centreOf = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
  const undoButton = () => sheet().getByRole('button', { name: 'Undo', exact: true })
  const redoButton = () => sheet().getByRole('button', { name: 'Redo', exact: true })
  const openEditor = async (address: string) => {
    await command(`/osg ${address}`)
    await sheet().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => field('Headline').isEnabled(), { timeout: 30_000 }).toBe(true)
  }
  const closeEditor = async () => {
    await sheet().getByRole('button', { name: /^Close/ }).click()
    await sheet().waitFor({ state: 'hidden', timeout: 10_000 })
  }
  const shownBox = async (locator: Locator) => {
    await expect.poll(async () => (await boxOf(locator)).width, { timeout: testBudget(15_000) }).toBeGreaterThan(0)
    return boxOf(locator)
  }
  async function stage(size: Size) {
    const overlay = (await sheet().locator('.graphics-overlay').boundingBox())!
    const scale = size.width / overlay.width
    return { scale, toScreen: (point: Point): Point => ({ x: overlay.x + point.x / scale, y: overlay.y + point.y / scale }) }
  }
  async function pointerDrag(from: Point, to: Point, free: boolean): Promise<string[]> {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    if (free) await page.keyboard.down('Alt')
    await page.mouse.move(to.x, to.y, { steps: 12 })
    const guides = await sheet().locator('.graphics-snap-guide').evaluateAll((nodes) => nodes.map((node) => `${(node as HTMLElement).dataset.axis}:${(node as HTMLElement).dataset.at}`))
    await page.mouse.up()
    if (free) await page.keyboard.up('Alt')
    return guides
  }
  async function dragLayerTo(locator: Locator, size: Size, target: Point, free: boolean) {
    const { scale, toScreen } = await stage(size)
    const guides = await pointerDrag(toScreen(centreOf(await boxOf(locator))), toScreen(target), free)
    return { scale, guides }
  }
  async function dragHandle(handle: string, by: Point) {
    const point = (await sheet().locator(`.graphics-handle[data-handle="${handle}"]`).boundingBox())!
    const from = { x: point.x + point.width / 2, y: point.y + point.height / 2 }
    await pointerDrag(from, { x: from.x + by.x, y: from.y + by.y }, false)
  }

  it('drags a layer to where the pointer goes on 9:16, 1:1 and 16:9 videos, one undo step per drag, and keeps it after a reload', async () => {
    const cases = [
      { address: '@a1', assetId: sourceId, size: PORTRAIT, layer: 'Image' },
      { address: '@a4', assetId: squareId, size: SQUARE, layer: 'Handle' },
      { address: '@a5', assetId: wideId, size: WIDE, layer: 'Handle' },
    ]
    const placed: Array<{ address: string; layerId: string; box: Box }> = []
    for (const entry of cases) {
      await openEditor(entry.address)
      const locator = layerBox(entry.layer)
      const before = await shownBox(locator)
      const layerId = (await locator.getAttribute('data-layer-id'))!
      const stored = (await read(entry.assetId)).document.layers.find((layer) => layer.id === layerId)!.position
      const target = { x: Math.round(entry.size.width * 0.3), y: Math.round(entry.size.height * 0.62) }
      const { scale, guides } = await dragLayerTo(locator, entry.size, target, true)
      expect(guides).toEqual([])
      const tolerance = Math.max(2, scale * 1.5)
      await expect.poll(async () => Math.abs(centreOf(await boxOf(locator)).x - target.x), { timeout: testBudget(15_000) }).toBeLessThanOrEqual(tolerance)
      const after = await boxOf(locator)
      expect(Math.abs(centreOf(after).y - target.y)).toBeLessThanOrEqual(tolerance)
      expect(after.width).toBe(before.width)
      await saved()
      const moved = (await read(entry.assetId)).document.layers.find((layer) => layer.id === layerId)!.position
      expect(moved).toMatchObject({ anchor: stored!.anchor, space: stored!.space })
      expect(moved).not.toEqual(stored)
      await undoButton().click()
      await expect.poll(() => boxOf(locator), { timeout: testBudget(15_000) }).toEqual(before)
      await redoButton().click()
      await expect.poll(() => boxOf(locator), { timeout: testBudget(15_000) }).toEqual(after)
      await saved()
      placed.push({ address: entry.address, layerId, box: after })
      await closeEditor()
    }
    await page.reload()
    for (const entry of placed) {
      await openEditor(entry.address)
      await expect.poll(() => boxOf(sheet().locator(`.graphics-layer-box[data-layer-id="${entry.layerId}"]`)), { timeout: testBudget(15_000) }).toEqual(entry.box)
      await closeEditor()
    }
    expect(errors).toEqual([])
  })

  it('snaps to the centre line near it unless Alt is held, resizes with handles and nudges from the keyboard, each one undo step', async () => {
    await openEditor('@a4')
    const handle = layerBox('Handle')
    await shownBox(handle)
    const near = { x: SQUARE.width / 2 + 5, y: Math.round(SQUARE.height * 0.3) }
    const snapped = await dragLayerTo(handle, SQUARE, near, false)
    expect(snapped.guides).toEqual([`x:${SQUARE.width / 2}`])
    await expect.poll(async () => centreOf(await boxOf(handle)).x, { timeout: testBudget(15_000) }).toBe(SQUARE.width / 2)
    await saved()
    const free = await dragLayerTo(handle, SQUARE, { x: SQUARE.width / 2 + 5, y: Math.round(SQUARE.height * 0.32) }, true)
    expect(free.guides).toEqual([])
    await expect.poll(async () => Math.abs(centreOf(await boxOf(handle)).x - (SQUARE.width / 2 + 5)), { timeout: testBudget(15_000) }).toBeLessThanOrEqual(Math.max(2, free.scale * 1.5))
    await saved()

    const placed = await boxOf(handle)
    await handle.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await boxOf(handle)).x, { timeout: testBudget(15_000) }).toBe(placed.x + 4)
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(async () => (await boxOf(handle)).y, { timeout: testBudget(15_000) }).toBe(placed.y + 40)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await boxOf(handle)).y, { timeout: testBudget(15_000) }).toBe(placed.y)
    expect((await boxOf(handle)).x).toBe(placed.x + 4)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => (await boxOf(handle)).y, { timeout: testBudget(15_000) }).toBe(placed.y + 40)
    const count = async () => (await read(squareId)).document.layers.length
    await saved()
    const layers = await count()
    await handle.focus()
    await page.keyboard.press('Control+d')
    await expect.poll(() => sheet().getByRole('region', { name: 'Layers' }).locator('.graphics-layer-row').count(), { timeout: testBudget(15_000) }).toBe(layers + 1)
    await sheet().locator('.graphics-layer-box[data-selected="true"]').focus()
    await page.keyboard.press('Delete')
    await expect.poll(() => sheet().getByRole('region', { name: 'Layers' }).locator('.graphics-layer-row').count(), { timeout: testBudget(15_000) }).toBe(layers)
    await saved()
    expect(await count()).toBe(layers)
    await closeEditor()

    await openEditor('@a1')
    const image = layerBox('Image')
    await image.click()
    const small = await shownBox(image)
    await dragHandle('size', { x: 30, y: 15 })
    await expect.poll(async () => (await boxOf(image)).width, { timeout: testBudget(15_000) }).toBeGreaterThan(small.width)
    const grown = await boxOf(image)
    expect([grown.x, grown.y]).toEqual([small.x, small.y])
    await saved()
    await undoButton().click()
    await expect.poll(() => boxOf(image), { timeout: testBudget(15_000) }).toEqual(small)
    await saved()
    await closeEditor()

    await openEditor('@a3')
    const title = layerBox('Title')
    await title.click()
    const wide = await shownBox(title)
    const widthBefore = (await read(thirdId)).document.layers.find((layer) => layer.name === 'Title')!
    await dragHandle('width-end', { x: -60, y: 0 })
    await expect.poll(async () => (await boxOf(title)).width, { timeout: testBudget(15_000) }).toBeLessThan(wide.width)
    await saved()
    const narrowed = (await read(thirdId)).document.layers.find((layer) => layer.name === 'Title') as Layer & { width?: number }
    expect(narrowed.width).toBeLessThan((widthBefore as Layer & { width?: number }).width!)
    await undoButton().click()
    await expect.poll(() => boxOf(title), { timeout: testBudget(15_000) }).toEqual(wide)
    await sheet().getByRole('region', { name: 'Layers' }).getByRole('button', { name: 'Select layer Shade', exact: true }).click()
    const shade = sheet().locator('.graphics-scrim-box')
    const low = parseBox(await shade.getAttribute('data-box'))
    await dragHandle('height', { x: 0, y: -30 })
    await expect.poll(async () => parseBox(await shade.getAttribute('data-box')).y, { timeout: testBudget(15_000) }).toBeLessThan(low.y)
    await saved()
    await undoButton().click()
    await expect.poll(async () => parseBox(await shade.getAttribute('data-box')).y, { timeout: testBudget(15_000) }).toBe(low.y)
    await saved()
    await closeEditor()
    expect(errors).toEqual([])
  })

  it('shows a layer limited to the last 3 seconds only then, in the preview and in the render', async () => {
    await openEditor('@a5')
    await field('Headline').fill('Late title')
    const layers = sheet().getByRole('region', { name: 'Layers' })
    await layers.getByRole('button', { name: 'Hide Handle', exact: true }).click()
    await layers.getByRole('button', { name: 'Select layer Title', exact: true }).click()
    const timing = sheet().getByRole('region', { name: 'Timing' })
    await timing.getByRole('group', { name: 'Show', exact: true }).getByRole('button', { name: 'Last', exact: true }).click()
    await expect.poll(() => timing.getByLabel('Last seconds', { exact: true }).inputValue(), { timeout: testBudget(15_000) }).toBe('3')
    const titleId = (await layerBox('Title').getAttribute('data-layer-id'))!
    await expect.poll(() => sheet().locator(`.graphics-timing-row[data-layer-id="${titleId}"]`).getAttribute('data-window'), { timeout: testBudget(15_000) }).toBe('3,6')
    expect(await timing.locator('.graphics-timing-summary').textContent()).toBe('Shows 3–6 s of 6 s')
    await timing.getByLabel('Last seconds', { exact: true }).fill('3')
    await timing.getByLabel('Last seconds', { exact: true }).press('Enter')
    expect(await sheet().isVisible()).toBe(true)
    await saved()
    expect((await read(wideId)).document.layers.find((layer) => layer.id === titleId)).toMatchObject({ timing: { start: null, end: null, tail: 3 } })

    await layers.getByRole('button', { name: 'Select layer Shade', exact: true }).click()
    const seek = sheet().getByLabel('Playback position', { exact: true })
    await seek.fill('30')
    await expect.poll(() => sheet().locator('.graphics-time').textContent(), { timeout: testBudget(15_000) }).toContain('0:01.00')
    await expect.poll(() => layerBox('Title').count(), { timeout: testBudget(15_000) }).toBe(0)
    await seek.fill('135')
    await expect.poll(() => layerBox('Title').count(), { timeout: testBudget(15_000) }).toBe(1)
    const previewed = await shownBox(layerBox('Title'))
    await shot('graphics-last-three-seconds')

    await sheet().getByRole('button', { name: /^Render/ }).click()
    await sheet().waitFor({ state: 'hidden', timeout: 30_000 })
    expect(renders.at(-1)).toMatchObject({ op: 'render', output: 'new', asset_id: wideId })
    await expect.poll(async () => (await read(wideId)).render?.status, { timeout: testBudget(180_000) }).toBe('completed')
    const output = (await read(wideId)).render!.output_asset_id
    const tolerance = Math.min(WIDE.width, WIDE.height) * 0.01
    expect(inkBox(await frame(output, 1, WIDE), previewed, tolerance, WIDE).count).toBe(0)
    expect(inkBox(await frame(output, 2.9, WIDE), previewed, tolerance, WIDE).count).toBe(0)
    const late = inkBox(await frame(output, 4.5, WIDE), previewed, tolerance, WIDE)
    expect(late.count).toBeGreaterThan(300)
    expect(late.x).toBeGreaterThanOrEqual(previewed.x - tolerance)
    expect(late.x + late.width).toBeLessThanOrEqual(previewed.x + previewed.width + tolerance)
    expect(errors).toEqual([])
  })

  it('stacks the editor at 390 px wide and moves a layer with a touch drag', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
    const phone = await context.newPage()
    const phoneErrors: string[] = []
    phone.on('pageerror', (error) => phoneErrors.push(error.message))
    try {
      await phone.addInitScript((id) => localStorage.setItem('videobook.active-book', id), bookId)
      await phone.goto(appUrl, { timeout: testBudget(30_000) })
      const input = phone.getByLabel('Videobook command input', { exact: true })
      await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
      await input.fill('/osg @a4')
      await phone.getByRole('button', { name: 'Send command', exact: true }).click()
      const editor = phone.getByRole('dialog', { name: 'Graphics editor', exact: true })
      await editor.waitFor({ state: 'visible', timeout: 30_000 })
      await expect.poll(() => editor.getByLabel('Headline', { exact: true }).isEnabled(), { timeout: 30_000 }).toBe(true)
      expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
      const preview = (await editor.locator('.graphics-preview').boundingBox())!
      const controls = (await editor.locator('.graphics-controls').boundingBox())!
      expect(controls.y).toBeGreaterThanOrEqual(preview.y + preview.height - 1)
      expect(controls.height).toBeGreaterThan(200)
      const locator = editor.locator('.graphics-layer-box[aria-label="Select Handle"]')
      await expect.poll(async () => parseBox(await locator.getAttribute('data-box')).width, { timeout: testBudget(15_000) }).toBeGreaterThan(0)
      await locator.scrollIntoViewIfNeeded()
      const before = parseBox(await locator.getAttribute('data-box'))
      const overlay = (await editor.locator('.graphics-overlay').boundingBox())!
      const scale = SQUARE.width / overlay.width
      const from = { x: overlay.x + centreOf(before).x / scale, y: overlay.y + centreOf(before).y / scale }
      const cdp = await context.newCDPSession(phone)
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', point: Point | null) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [] })
      await touch('touchStart', from)
      for (let step = 1; step <= 10; step += 1) await touch('touchMove', { x: from.x, y: from.y - 4 * step })
      await touch('touchEnd', null)
      await expect.poll(async () => before.y - parseBox(await locator.getAttribute('data-box')).y, { timeout: testBudget(15_000) }).toBeGreaterThan(40 * scale - Math.max(2, scale * 1.5))
      const after = parseBox(await locator.getAttribute('data-box'))
      expect(Math.abs(before.y - after.y - 40 * scale)).toBeLessThanOrEqual(Math.max(2, scale * 1.5))
      expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
      expect(phoneErrors).toEqual([])
    } finally {
      await context.close()
    }
  })

  it('saves a look as a template, applies it keeping the typed headline, makes it the default and copies a template from another book', async () => {
    const templates = () => sheet().getByRole('region', { name: 'Templates', exact: true })
    const notice = () => templates().getByRole('status')
    const layerNames = (read: Read) => read.document.layers.map((layer) => layer.name)
    const close = async () => {
      await sheet().getByRole('button', { name: /^Close/ }).click()
      await sheet().waitFor({ state: 'hidden', timeout: 10_000 })
    }
    const open = async (address: string) => {
      await command(`/osg ${address}`)
      await sheet().waitFor({ state: 'visible', timeout: 30_000 })
      await expect.poll(() => field('Headline').isEnabled(), { timeout: 30_000 }).toBe(true)
    }

    await open('@a1')
    await templates().getByLabel('Template name', { exact: true }).fill('Brand look')
    await templates().getByRole('button', { name: 'Save as template', exact: true }).click()
    await expect.poll(() => notice().textContent(), { timeout: testBudget(15_000) }).toBe('Saved “Brand look” as a template.')
    const brand = (await read()).templates.find((template) => template.name === 'Brand look')!
    expect(brand.document.layers.map((layer) => layer.name)).toEqual(layerNames(await read()))
    expect(brand.document.layers.flatMap((layer) => layer.items ?? []).filter((item) => item.slot === 'headline').map((item) => item.text)).toEqual([''])
    await close()

    await open('@a3')
    await field('Headline').fill('Typed on a3')
    await saved()
    await templates().getByRole('button', { name: 'Brand look', exact: true }).click()
    await expect.poll(() => field('Headline').inputValue()).toBe('Typed on a3')
    await saved()
    const applied = await read(thirdId)
    expect(layerNames(applied)).toEqual(brand.document.layers.map((layer) => layer.name))
    expect(slotText(applied, 'headline')).toBe('Typed on a3')

    await templates().getByRole('button', { name: 'Manage templates', exact: true }).click()
    await templates().getByRole('button', { name: 'Make Brand look the default', exact: true }).click()
    await expect.poll(() => notice().textContent(), { timeout: testBudget(15_000) }).toBe('Brand look is now the look for videos in this book that have no graphics yet.')
    await close()

    await open('@a2')
    const fresh = await read(secondId)
    expect(fresh).toMatchObject({ saved: false, default_template_id: brand.id })
    expect(layerNames(fresh)).toEqual(brand.document.layers.map((layer) => layer.name))
    expect(await templates().getByRole('button', { name: 'Brand look', exact: true }).getAttribute('data-default')).toBe('true')
    await shot('graphics-templates')

    await templates().getByRole('button', { name: 'Manage templates', exact: true }).click()
    await templates().getByLabel('Book to copy templates from', { exact: true }).selectOption({ label: 'brand-kit' })
    await templates().getByRole('button', { name: 'Copy templates', exact: true }).click()
    await expect.poll(() => notice().textContent(), { timeout: testBudget(60_000) }).toBe('Copied 1 template from brand-kit.')
    await templates().getByRole('button', { name: 'Brand kit', exact: true }).click()
    const layers = sheet().getByRole('region', { name: 'Layers' })
    await expect.poll(() => layers.getByRole('button', { name: 'Select layer Kit logo', exact: true }).textContent()).toContain('Kit logo')
    expect(await layers.getByRole('button', { name: 'Select layer Kit logo', exact: true }).textContent()).not.toContain('not loaded')
    await saved()
    const copied = await read(secondId)
    const image = copied.document.layers.find((layer) => layer.kind === 'image')!
    expect(image.artifactId).not.toBe(kitLogoId)
    expect(copied.images[image.artifactId!]?.url).toMatch(new RegExp(`^/files/${bookId}/${image.artifactId}/`))
    await close()
    expect(errors).toEqual([])
  })

  it('opens /watermark and a routed watermark plan as the editor in watermark mode, burns in place by default and saves the default watermark', async () => {
    const editor = () => page.getByRole('dialog', { name: 'Watermark editor', exact: true })
    const editorField = (label: string) => editor().getByLabel(label, { exact: true })
    const panel = () => editor().getByRole('region', { name: 'Watermark', exact: true })
    const platform = (name: string) => panel().getByRole('group', { name: 'Watermark platform', exact: true }).getByRole('button', { name, exact: true })
    const layers = () => editor().getByRole('region', { name: 'Layers' })
    const readWatermark = (name = 'tiktok') => call<Read>('video_graphics', { asset_id: watermarkId, watermark: true, platform: name })
    const close = async () => {
      await editor().getByRole('button', { name: /^Close/ }).click()
      await editor().waitFor({ state: 'hidden', timeout: 10_000 })
    }
    const changed = (pixels: Buffer, from: number, to: number) => {
      let count = 0
      for (let y = Math.round(from); y < Math.round(to); y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          const offset = (y * WIDTH + x) * 3
          if (Math.abs(pixels[offset] - 0x20) + Math.abs(pixels[offset + 1] - 0x60) + Math.abs(pixels[offset + 2] - 0xa0) > 30) count += 1
        }
      }
      return count
    }

    await command('/watermark @b3')
    await editor().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => platform('TikTok').getAttribute('aria-pressed'), { timeout: 30_000 }).toBe('true')
    expect(await editor().getByRole('group', { name: 'Render output', exact: true }).getByRole('button', { name: 'Replace video', exact: true }).getAttribute('aria-pressed')).toBe('true')
    const fresh = await readWatermark()
    expect(fresh).toMatchObject({ saved: false, watermark: { platform: 'tiktok', template_id: null } })
    expect(fresh.document.layers.map((layer) => layer.kind)).toEqual(['scrim', 'text', 'text'])
    const shades = () => editor().locator(`.graphics-timing-row[data-layer-id="${fresh.document.layers[0].id}"]`)
    const handleItem = editor().locator('.graphics-item-box[data-slot="handle"]').first()
    await expect.poll(async () => parseBox(await handleItem.getAttribute('data-box')).height, { timeout: testBudget(15_000) }).toBeGreaterThan(0)
    expect(await shades().count()).toBe(0)
    await editorField('Headline').fill(THAI_TITLE)
    await expect.poll(() => shades().count(), { timeout: testBudget(15_000) }).toBe(1)
    await shot('watermark-editor')
    await editorField('Headline').fill('')
    await expect.poll(() => shades().count(), { timeout: testBudget(15_000) }).toBe(0)
    await expect.poll(() => editor().locator('.graphics-save-state').textContent(), { timeout: testBudget(15_000) }).toBe('Saved')
    await editor().getByRole('button', { name: /^Render/ }).click()
    await editor().waitFor({ state: 'hidden', timeout: 30_000 })
    expect(renders.at(-1)).toMatchObject({ op: 'render', output: 'replace', asset_id: watermarkId, watermark: true, platform: 'tiktok' })
    await expect.poll(async () => (await readWatermark()).burned?.output ?? null, { timeout: testBudget(180_000) }).toBe('replace')
    await expect.poll(async () => (await readWatermark()).source.source_hash, { timeout: testBudget(60_000) }).not.toBe(fresh.source.source_hash)
    const burned = await frame(watermarkId, 1)
    expect(changed(burned, 0, HEIGHT * 0.25)).toBeGreaterThan(300)
    expect(changed(burned, HEIGHT * 0.5, HEIGHT)).toBe(0)
    const ready = await client!.callTool({ name: 'wait_for_asset_ready', arguments: { book_id: bookId, asset_id: watermarkId, timeout_seconds: 180 } })
    expect(ready.isError).not.toBe(true)

    const typed = 'watermark @b3 for X with a QR code'
    const plan = {
      kind: 'chat-action-plan',
      planId: crypto.randomUUID(),
      bookId,
      prompt: typed,
      routedTool: 'apply_watermark',
      tool: 'apply_watermark',
      params: { asset_id: '@b3', platform: 'x', include_qr: true },
      message: 'Applying watermark.',
      summary: 'Applying watermark.',
      effect: 'mutation',
      confirmation: { required: true, reason: 'This request changes the current book' },
    }
    await page.route('**/mcp', async (route) => {
      const body = await requestBody(route)
      const envelope = (Array.isArray(body) ? body : [body]).map(record).find((entry) => {
        const params = record(entry?.params)
        return entry?.method === 'tools/call' && params?.name === 'chat' && String(record(params.arguments)?.prompt ?? '').includes('for X with a QR code')
      })
      if (!envelope) return route.continue()
      const response = { jsonrpc: '2.0', id: envelope.id, result: { resultType: 'complete', content: [{ type: 'text', text: JSON.stringify(plan) }], isError: false } }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? [response] : response) })
    })
    const rendersBefore = renders.length
    try {
      await expect.poll(async () => {
        await command(typed)
        return editor().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)
      }, { timeout: testBudget(60_000), interval: 1_000 }).toBe(true)
    } finally {
      await page.unroute('**/mcp')
    }
    await expect.poll(() => platform('X').getAttribute('aria-pressed'), { timeout: 30_000 }).toBe('true')
    await expect.poll(async () => (await layers().textContent()) ?? '', { timeout: testBudget(15_000) }).toContain('Profile link')
    expect(await layers().textContent()).toContain('justinwtanner')
    await expect.poll(() => editor().locator('.graphics-save-state').textContent(), { timeout: testBudget(15_000) }).toBe('Saved')
    expect((await readWatermark('x')).document.layers.map((layer) => layer.kind)).toEqual(['text', 'qr'])

    await panel().getByRole('button', { name: 'Save as default watermark', exact: true }).click()
    await expect.poll(() => panel().getByRole('status').textContent(), { timeout: testBudget(15_000) })
      .toBe('Saved as the default X watermark (“X watermark”). Goal finishing and apply_watermark burn it from now on.')
    expect((await readWatermark('x')).watermark).toMatchObject({ template_name: 'X watermark' })
    await expect.poll(async () => (await panel().textContent()) ?? '').toContain('burn your saved X watermark, “X watermark”.')
    await panel().getByRole('button', { name: 'Use the profile’s look', exact: true }).click()
    await expect.poll(() => panel().getByRole('status').textContent(), { timeout: testBudget(15_000) }).toBe('Goal finishing and apply_watermark burn the X profile’s watermark again.')
    expect((await readWatermark('x')).watermark?.template_id).toBeNull()

    await platform('TikTok').click()
    await expect.poll(() => platform('TikTok').getAttribute('aria-pressed'), { timeout: testBudget(15_000) }).toBe('true')
    await expect.poll(async () => (await layers().textContent()) ?? '', { timeout: testBudget(15_000) }).not.toContain('Profile link')
    expect(await layers().textContent()).toContain('Empty headline, second line')
    await expect.poll(() => editor().locator('.graphics-save-state').textContent(), { timeout: testBudget(15_000) }).toBe('Saved')
    expect((await readWatermark()).document.layers.map((layer) => layer.kind)).toEqual(['scrim', 'text', 'text'])
    await close()
    expect(renders.length).toBe(rendersBefore)
    expect(errors).toEqual([])
  })
})
