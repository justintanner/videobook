import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
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
  saved: boolean
  revision: string
  document: { layers: Layer[] }
  render: { request_id: string; status: string; output_asset_id: string; address: string | null; error: string | null } | null
  burned: { request_id: string; output: string } | null
  source: { source_hash: string }
}
type NotebookWire = { cells: Array<{ id: string; output_artifact_id?: string; slot: { row: number; column: number } }> }

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
  let bookId = ''
  let notebookId = ''
  let sourceId = ''
  let secondId = ''
  let thirdId = ''
  let thirdCellId = ''
  let logoId = ''
  let logoCellId = ''
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

  async function frame(assetId: string, seconds: number): Promise<Buffer> {
    const path = join(root, `${assetId}-${Date.now()}.mp4`)
    const response = await fetch(`${origin}/files/${bookId}/${assetId}/original.mp4`)
    expect(response.status).toBe(200)
    await writeFile(path, Buffer.from(await response.arrayBuffer()))
    const { stdout } = await exec(FFMPEG, ['-v', 'error', '-ss', seconds.toFixed(3), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: WIDTH * HEIGHT * 4 })
    return stdout
  }

  function inkBox(pixels: Buffer, band: Box, tolerance: number): Box & { count: number } {
    const box = { minX: WIDTH, maxX: -1, minY: HEIGHT, maxY: -1, count: 0 }
    const top = Math.max(0, Math.floor(band.y - tolerance))
    const bottom = Math.min(HEIGHT, Math.ceil(band.y + band.height + tolerance))
    for (let y = top; y < bottom; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const offset = (y * WIDTH + x) * 3
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

  async function video(path: string, label: string, original?: Record<string, unknown>) {
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x2060a0:s=${WIDTH}x${HEIGHT}:r=30:d=${DURATION}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURATION}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path])
    return { path, label, original }
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
    const fixtures = [await video(join(root, 'red-light.mp4'), 'Red light', TIKTOK_SOURCE), await video(join(root, 'second.mp4'), 'Second take'), await video(join(root, 'third.mp4'), 'Third take')]
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
      await engine.files.write(artifact.value.artifactId, 'original.jpg', await extractVideoPoster(fixture.path, DURATION))
      ids.push(artifact.value.artifactId)
    }
    ;[sourceId, secondId, thirdId] = ids
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
    const logoCell = engine.notebooks.createCell({ type: 'image', slot: { row: 1, column: 1 }, outputArtifactId: logoId })
    logoCellId = logoCell.id
    await engine.notebooks.insertCell(notebook.id, logoCell)
    await manager.close()
    const port = await availablePort()
    origin = `http://127.0.0.1:${port}`
    const env = { ...process.env, NODE_ENV: 'test', OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '', PORT: String(port), VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json') }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'graphics-ui', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    const vitePort = await availablePort()
    const appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/mcp')) return
      renders.push(...toolCalls(request.postDataJSON()).filter(item => item.name === 'video_graphics' && item.arguments.op === 'render').map(item => item.arguments))
    })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
  }, 90_000)

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
    expect((await call<NotebookWire>('get_notebook', { notebook_id: notebookId })).cells).toHaveLength(5)
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
})
