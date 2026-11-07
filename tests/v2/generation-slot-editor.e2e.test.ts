import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MANAGED_ENV_KEYS } from '../../server/src/env-secrets.js'
import { testBudget } from '../../server/src/test-budget.js'

type StartedProcess = { child: ChildProcess; output: string[] }
type Edge = { id: string; source: string; target: string; targetInput: string }
type Cell = { id: string; provider?: string; model?: string; operation?: string; tool?: string; prompt?: string; inputs?: Record<string, unknown> }
type Notebook = { cells: Cell[]; edges: Edge[] }

const GROK = 'kie:grok-imagine-video-1-5-preview'
const PICKED = 'kie:grok-imagine/image-to-video'

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port')))
    })
  })
}

function startProcess(args: string[], env: NodeJS.ProcessEnv): StartedProcess {
  const output: string[] = []
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', (data: Buffer) => output.push(data.toString()))
  child.stderr?.on('data', (data: Buffer) => output.push(data.toString()))
  return { child, output }
}

async function waitForHttp(url: string, started: StartedProcess): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (started.child.exitCode !== null) throw new Error(`Process exited:\n${started.output.join('')}`)
    const status = await fetch(url).then((response) => response.status, () => 0)
    if (status === 200) return
    await wait(100)
  }
  throw new Error(`Process did not start:\n${started.output.join('')}`)
}

async function stopProcess(started: StartedProcess | undefined): Promise<void> {
  if (!started || started.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => started.child.once('exit', () => resolve()))
  started.child.kill('SIGINT')
  if (await Promise.race([exited.then(() => true), wait(5_000).then(() => false)])) return
  started.child.kill('SIGKILL')
  await exited
}

function resultValue(value: unknown): unknown {
  const content = (value as { content?: Array<{ type: string; text?: string }> }).content ?? []
  const text = content.find((item) => item.type === 'text')?.text
  return text ? JSON.parse(text) as unknown : null
}

describe('generation slot editor in the browser', () => {
  let rootDir: string
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser | undefined
  let page: Page
  let client: Client
  let bookId: string
  let notebookId: string
  let images: string[]
  let generationId: string
  let editId: string

  const call = async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: { book_id: bookId, notebook_id: notebookId, ...args } })
    if ((result as { isError?: boolean }).isError) throw new Error(JSON.stringify(result))
    return resultValue(result) as T
  }
  const keyframes = async () => (await call<Notebook>('get_notebook')).edges
    .filter((edge) => edge.target === generationId)
    .map((edge) => [images.indexOf(edge.source), edge.targetInput])
    .sort((left, right) => String(left[1]).localeCompare(String(right[1])))
  const slot = (label: string): Locator => page.locator(`.inspector .generation-slot[aria-label="${label}"]`)
  const chip = (label: string, index: number): Locator => slot(label).locator('.generation-slot-chip').nth(index)

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-slot-editor-e2e-'))
    const serverPort = await availablePort()
    const vitePort = await availablePort()
    const origin = `http://127.0.0.1:${serverPort}`
    await writeFile(join(rootDir, '.env'), '')
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], {
      ...process.env,
      ...Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, ''])),
      KIE_API_KEY: 'test-slot-editor-e2e',
      PORT: String(serverPort),
      VIDEOBOOK_ENV_PATH: join(rootDir, '.env'),
      VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime', 'app-state.json'),
      VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
      VIDEOBOOK_DOWNLOADS_DIR: join(rootDir, 'downloads'),
    })
    await waitForHttp(`${origin}/healthz`, server)
    client = new Client({ name: 'slot-editor-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    bookId = (resultValue(await client.callTool({ name: 'create_book', arguments: { name: 'slot-editor-e2e' } })) as { bookId: string }).bookId
    notebookId = (resultValue(await client.callTool({ name: 'list_notebooks', arguments: { book_id: bookId } })) as Array<{ id: string }>)[0]!.id
    images = []
    for (const [index, color] of ['#c0392b', '#2980b9', '#27ae60'].entries()) {
      const png = await sharp({ create: { width: 64, height: 96, channels: 3, background: color } }).png().toBuffer()
      const uploaded = await call<{ assetId: string }>('upload_file', { filename: `still-${index}.png`, data: png.toString('base64') })
      images.push((await call<{ id: string }>('create_notebook_cell', {
        cell: { type: 'image', slot: { row: 0, column: index }, output_artifact_id: uploaded.assetId },
      })).id)
    }
    generationId = (await call<{ id: string }>('create_notebook_cell', {
      cell: { type: 'generate_video', slot: { row: 1, column: 0 }, prompt: 'Hold @image1, pass @keyframe1, land on @keyframe2', provider: 'kie', model: GROK, operation: 'image_to_video', tool: 'generate_video', inputs: { generationMode: 'i2v', generationSettings: { duration: 10 } } },
    })).id
    editId = (await call<{ id: string }>('create_notebook_cell', {
      cell: { type: 'generate_image', slot: { row: 2, column: 0 }, prompt: 'Swap the sky', provider: 'fal', model: 'fal:openai/gpt-image-2/edit', operation: 'edit_image', tool: 'generate_image' },
    })).id
    vite = startProcess([join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort)], {
      ...process.env,
      VIDEOBOOK_SERVER_URL: origin,
      VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache'),
      VIDEOBOOK_VITE_HMR: '0',
    })
    await waitForHttp(`http://127.0.0.1:${vitePort}`, vite)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    page.setDefaultTimeout(testBudget(30_000))
    page.setDefaultNavigationTimeout(testBudget(120_000))
    await page.goto(`http://127.0.0.1:${vitePort}`)
  }, testBudget(300_000))

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  beforeEach(async () => {
    await call('set_notebook_cell_inputs', {
      cell_id: generationId,
      inputs: [
        { source_cell_id: images[0], target_input: 'image', params: {} },
        { source_cell_id: images[1], target_input: 'keyframe', params: {} },
        { source_cell_id: images[2], target_input: 'keyframe_2', params: {} },
      ],
    })
    await call('update_notebook_cell', { cell_id: generationId, cell: { provider: 'kie', model: GROK, operation: 'image_to_video', tool: 'generate_video', prompt: 'Hold @image1, pass @keyframe1, land on @keyframe2', inputs: { generationMode: 'i2v', generationSettings: { duration: 10 } } } })
    await page.reload()
    await page.locator(`.notebook-flow .react-flow__node[data-id="${generationId}"] .cell-node`).click({ timeout: testBudget(60_000) })
    await chip('Keyframes', 1).waitFor({ state: 'visible', timeout: testBudget(30_000) })
  }, testBudget(120_000))

  it('reorders keyframes by dragging the grip and renumbers the prompt', async () => {
    await chip('Keyframes', 1).locator('.generation-slot-grip').dragTo(chip('Keyframes', 0), { targetPosition: { x: 40, y: 6 } })
    await expect.poll(keyframes, { timeout: testBudget(15_000) }).toEqual([[0, 'image'], [2, 'keyframe'], [1, 'keyframe_2']])
    expect((await call<Notebook>('get_notebook')).cells.find((cell) => cell.id === generationId)?.prompt)
      .toBe('Hold @image1, pass @keyframe2, land on @keyframe1')
    await expect.poll(async () => await chip('Keyframes', 0).locator('.generation-slot-chip-meta > small').textContent()).toBe('@a3')
  }, testBudget(90_000))

  it('moves a keyframe into reference images and refuses a second one at 1080p', async () => {
    await page.locator('.inspector').getByLabel('Resolution').selectOption({ label: '1080p' })
    const grip = chip('Keyframes', 0).locator('.generation-slot-grip')
    await grip.hover()
    await page.mouse.down()
    const target = slot('Reference images').locator('.generation-slot-chip').first()
    const box = (await target.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4, { steps: 8 })
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height - 6)
    await expect.poll(async () => await slot('Reference images').getAttribute('data-refused')).toBe('true')
    expect(await slot('Reference images').locator('.generation-slot-refusal').textContent()).toBe('1080p takes one reference image')
    await page.mouse.up()
    expect(await keyframes()).toEqual([[0, 'image'], [1, 'keyframe'], [2, 'keyframe_2']])

    await page.locator('.inspector').getByLabel('Resolution').selectOption({ label: '720p' })
    await grip.dragTo(target, { targetPosition: { x: 40, y: (await target.boundingBox())!.height - 4 } })
    await expect.poll(keyframes, { timeout: testBudget(15_000) }).toEqual([[0, 'image'], [1, 'image_2'], [2, 'keyframe']])
  }, testBudget(90_000))

  it('keeps an unsaved model and settings picked in the inspector while inputs move', async () => {
    await call('set_notebook_cell_inputs', {
      cell_id: generationId,
      inputs: [
        { source_cell_id: images[0], target_input: 'image', params: {} },
        { source_cell_id: images[1], target_input: 'image_2', params: {} },
      ],
    })
    await call('update_notebook_cell', { cell_id: generationId, cell: { prompt: 'Blend @image1 into @image2' } })
    await page.reload()
    await page.locator(`.notebook-flow .react-flow__node[data-id="${generationId}"] .cell-node`).click({ timeout: testBudget(60_000) })
    const model = page.locator('.inspector').getByLabel('Generation model')
    await model.selectOption(`generation.${PICKED}`)
    const resolution = page.locator('.inspector').getByLabel('Resolution')
    await resolution.selectOption({ label: '720p' })
    const grip = chip('Reference images', 1).locator('.generation-slot-grip')
    await grip.focus()
    await page.keyboard.press('ArrowUp')
    await expect.poll(keyframes, { timeout: testBudget(15_000) }).toEqual([[1, 'image'], [0, 'image_2']])
    const saved = (await call<Notebook>('get_notebook')).cells.find((cell) => cell.id === generationId)
    expect(saved?.model).toBe(GROK)
    expect(saved?.prompt).toBe('Blend @image2 into @image1')
    expect(await model.inputValue()).toBe(`generation.${PICKED}`)
    expect(await resolution.locator('option:checked').textContent()).toBe('720p')
    await expect.poll(async () => await page.evaluate(() => document.activeElement?.closest('.generation-slot-chip')?.textContent ?? ''), {
      timeout: testBudget(15_000),
    }).toContain('@a2')
    await page.keyboard.press('ArrowDown')
    await expect.poll(keyframes, { timeout: testBudget(15_000) }).toEqual([[0, 'image'], [1, 'image_2']])
    expect((await call<Notebook>('get_notebook')).cells.find((cell) => cell.id === generationId)?.prompt).toBe('Blend @image1 into @image2')
    expect(await model.inputValue()).toBe(`generation.${PICKED}`)
    expect(await resolution.locator('option:checked').textContent()).toBe('720p')
  }, testBudget(90_000))

  it('takes a board cell dragged by its canvas grip into a slot', async () => {
    const nodes = await page.locator('.notebook-flow .react-flow__node').count()
    const grip = page.locator(`.notebook-flow .react-flow__node[data-id="${images[0]}"] .cell-ref-grip`)
    await grip.dragTo(chip('Keyframes', 1), { targetPosition: { x: 40, y: 50 } })
    await expect.poll(keyframes, { timeout: testBudget(15_000) })
      .toEqual([[0, 'image'], [1, 'keyframe'], [2, 'keyframe_2'], [0, 'keyframe_3']])
    expect(await page.locator('.notebook-flow .react-flow__node').count()).toBe(nodes)
  }, testBudget(90_000))

  it('opens an empty slot picker, searches large previews and saves the chosen image to that slot', async () => {
    await slot('Reference images').getByRole('button', { name: 'Remove @a1 from Reference images' }).click()
    await expect.poll(keyframes, { timeout: testBudget(15_000) }).toEqual([[1, 'keyframe'], [2, 'keyframe_2']])
    await slot('Reference images').getByRole('button', { name: 'Choose an image', exact: false }).click()
    const picker = page.getByRole('dialog', { name: 'Choose image for reference images' })
    await picker.waitFor({ state: 'visible' })
    expect(await picker.locator('.generation-input-picker-card').count()).toBe(4)
    expect(await picker.locator('.generation-input-picker-preview img').count()).toBe(3)
    const firstImage = picker.locator('.generation-input-picker-preview img').first()
    await expect.poll(() => firstImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    expect((await firstImage.boundingBox())!.height).toBeGreaterThan(140)
    await picker.getByRole('searchbox').fill('@a3')
    expect(await picker.locator('.generation-input-picker-card').count()).toBe(1)
    await picker.getByRole('button', { name: 'Add @a3 to Reference images' }).focus()
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    await expect.poll(keyframes, { timeout: testBudget(15_000) }).toEqual([[2, 'image'], [1, 'keyframe'], [2, 'keyframe_2']])
    await expect.poll(async () => await page.locator('.inspector .generation-review-json pre').textContent(), { timeout: testBudget(15_000) }).toContain('"image_urls"')
    await page.reload()
    await page.locator(`.notebook-flow .react-flow__node[data-id="${generationId}"] .cell-node`).click({ timeout: testBudget(60_000) })
    await expect.poll(async () => await chip('Reference images', 0).locator('.generation-slot-chip-meta > small').textContent()).toBe('@a3')
  }, testBudget(90_000))

  it('explains the image limit in the picker and permits another reference after lowering resolution', async () => {
    const inspector = page.locator('.inspector')
    await inspector.getByLabel('Resolution').selectOption({ label: '1080p' })
    const opener = slot('Reference images').getByRole('button', { name: 'Choose image for reference images' })
    await opener.click()
    const picker = page.getByRole('dialog', { name: 'Choose image for reference images' })
    expect(await picker.getByRole('button', { name: 'Add @a1 to Reference images' }).isDisabled()).toBe(true)
    const other = picker.getByRole('button', { name: 'Add @a2 to Reference images' })
    expect(await other.isDisabled()).toBe(true)
    expect(await other.textContent()).toContain('1080p takes one reference image')
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })
    expect(await opener.evaluate((button) => document.activeElement === button)).toBe(true)
    expect(await inspector.isVisible()).toBe(true)
    expect(await keyframes()).toEqual([[0, 'image'], [1, 'keyframe'], [2, 'keyframe_2']])
    await inspector.getByLabel('Resolution').selectOption({ label: '720p' })
    await opener.click()
    await other.click()
    await expect.poll(keyframes, { timeout: testBudget(15_000) }).toEqual([[0, 'image'], [1, 'image_2'], [1, 'keyframe'], [2, 'keyframe_2']])
  }, testBudget(90_000))

  it('keeps the picker and full thumbnails inside desktop, phone and short windows with keyboard focus contained', async () => {
    try {
      for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }, { width: 667, height: 375 }]) {
        await page.setViewportSize(viewport)
        const opener = slot('Keyframes').getByRole('button', { name: 'Choose image for keyframes' })
        await opener.click()
        const picker = page.getByRole('dialog', { name: 'Choose image for keyframes' })
        await picker.waitFor({ state: 'visible' })
        const bounds = (await picker.boundingBox())!
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.y).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
        await expect.poll(async () => await picker.locator('.generation-input-picker-preview img').evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true)
        const contained = await picker.locator('.generation-input-picker-preview img').evaluateAll((images) => images.every((image) => {
          const bounds = image.getBoundingClientRect()
          const frame = image.parentElement!.getBoundingClientRect()
          return bounds.width > 100 && bounds.height > 90 && getComputedStyle(image).objectFit === 'contain'
            && bounds.left >= frame.left && bounds.right <= frame.right
            && bounds.top >= frame.top && bounds.bottom <= frame.bottom
        }))
        expect(contained).toBe(true)
        expect(await picker.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true)
        expect(await picker.locator('.generation-input-picker-card').first().evaluate((card) => {
          const results = card.closest('.generation-input-picker-results')!
          return card.getBoundingClientRect().height <= results.clientHeight
        })).toBe(true)
        await picker.getByRole('button', { name: 'Close input picker' }).focus()
        await page.keyboard.press('Shift+Tab')
        expect(await picker.locator('.generation-input-picker-card:not(:disabled)').last().evaluate((button) => document.activeElement === button)).toBe(true)
        await page.keyboard.press('Tab')
        expect(await picker.getByRole('button', { name: 'Close input picker' }).evaluate((button) => document.activeElement === button)).toBe(true)
        await picker.getByRole('searchbox').fill('@z8')
        expect(await picker.getByRole('status').textContent()).toContain('No cells match')
        await picker.getByRole('button', { name: 'Close input picker' }).click()
        await picker.waitFor({ state: 'detached' })
        expect(await opener.evaluate((button) => document.activeElement === button)).toBe(true)
      }
    } finally {
      await page.setViewportSize({ width: 1600, height: 1000 })
    }
  }, testBudget(90_000))

  it('fills a request field without a role, such as an edit mask, from the board', async () => {
    await call('set_notebook_cell_inputs', { cell_id: editId, inputs: [{ source_cell_id: images[0], target_input: 'image', params: {} }] })
    await page.reload()
    await page.locator(`.notebook-flow .react-flow__node[data-id="${editId}"] .cell-node`).click({ timeout: testBudget(60_000) })
    const mask = slot('Mask')
    await mask.waitFor({ state: 'visible', timeout: testBudget(30_000) })
    expect(await mask.locator('.generation-slot-field').textContent()).toBe('mask_url')
    await page.locator('.inspector .generation-slot-tile').filter({ hasText: '@a2' }).locator('.generation-slot-grip').dragTo(mask.locator('.generation-slot-empty'))
    await expect.poll(async () => (await call<Notebook>('get_notebook')).edges
      .filter((edge) => edge.target === editId).map((edge) => [images.indexOf(edge.source), edge.targetInput]).sort(), { timeout: testBudget(15_000) })
      .toEqual([[0, 'image'], [1, 'slot:mask_url']])
    await expect.poll(async () => await page.locator('.inspector .generation-review-json pre').textContent(), { timeout: testBudget(15_000) })
      .toContain('"mask_url"')
  }, testBudget(90_000))

  it('drops an image into Mask for an unsaved edit model', async () => {
    const savedModel = 'kie:nano-banana-2-1'
    const draftModel = 'kie:qwen2-1/image-to-image'
    try {
      await call('update_notebook_cell', {
        cell_id: editId,
        cell: { provider: 'kie', model: savedModel, operation: 'text_to_image', tool: 'generate_image', prompt: 'Swap the sky' },
      })
      await call('set_notebook_cell_inputs', { cell_id: editId, inputs: [{ source_cell_id: images[0], target_input: 'image', params: {} }] })
      await page.reload()
      await page.locator(`.notebook-flow .react-flow__node[data-id="${editId}"] .cell-node`).click({ timeout: testBudget(60_000) })
      const model = page.locator('.inspector').getByLabel('Generation model')
      await model.selectOption(`generation.${draftModel}`)
      const mask = slot('Mask')
      await mask.waitFor({ state: 'visible', timeout: testBudget(30_000) })
      await page.locator('.inspector .generation-slot-tile').filter({ hasText: '@a2' }).locator('.generation-slot-grip').dragTo(mask.locator('.generation-slot-empty'))
      await expect.poll(async () => (await call<Notebook>('get_notebook')).edges
        .filter((edge) => edge.target === editId).map((edge) => [images.indexOf(edge.source), edge.targetInput]).sort(), { timeout: testBudget(15_000) })
        .toEqual([[0, 'image'], [1, 'slot:mask_url']])
      const saved = (await call<Notebook>('get_notebook')).cells.find((cell) => cell.id === editId)
      expect(saved?.model).toBe(savedModel)
      expect(saved?.provider).toBe('kie')
      expect(saved?.operation).toBe('text_to_image')
      expect(saved?.tool).toBe('generate_image')
      expect(await model.inputValue()).toBe(`generation.${draftModel}`)
    } finally {
      await call('update_notebook_cell', {
        cell_id: editId,
        cell: { provider: 'fal', model: 'fal:openai/gpt-image-2/edit', operation: 'edit_image', tool: 'generate_image', prompt: 'Swap the sky' },
      })
      await call('set_notebook_cell_inputs', { cell_id: editId, inputs: [] })
    }
  }, testBudget(90_000))

  it('commits a setting on Enter without starting a run', async () => {
    const runs: string[] = []
    const watch = (request: { url: () => string; postData: () => string | null }) => {
      const body = request.postData() ?? ''
      if (request.url().endsWith('/mcp') && /"name":"run_notebook/u.test(body)) runs.push(body)
    }
    page.on('request', watch)
    try {
      const duration = page.locator('.inspector').getByLabel('Duration', { exact: true })
      await duration.fill('8')
      await duration.press('Enter')
      await wait(2_500)
      expect(runs).toEqual([])
      expect(await duration.inputValue()).toBe('8')
    } finally {
      page.off('request', watch)
    }
  }, testBudget(60_000))

  it('stores a keyframe time typed on the item and moves it with the keyboard', async () => {
    const time = chip('Keyframes', 1).getByLabel('Time for @a3')
    expect(await time.getAttribute('placeholder')).toBe('6.67')
    await time.fill('4.5')
    await time.press('Enter')
    expect(await page.locator('.inspector').getByRole('button', { name: /Generating/ }).count()).toBe(0)
    await expect.poll(async () => (await call<Notebook>('get_notebook')).cells.find((cell) => cell.id === generationId)?.inputs?.inputParams, {
      timeout: testBudget(15_000),
    }).toEqual({ keyframe_2: { timestamp_s: 4.5 } })
    const grip = chip('Keyframes', 1).locator('.generation-slot-grip')
    await expect.poll(async () => await grip.isEnabled(), { timeout: testBudget(15_000) }).toBe(true)
    await grip.focus()
    await page.keyboard.press('ArrowUp')
    await expect.poll(keyframes, { timeout: testBudget(15_000) }).toEqual([[0, 'image'], [2, 'keyframe'], [1, 'keyframe_2']])
    await expect.poll(async () => (await call<Notebook>('get_notebook')).cells.find((cell) => cell.id === generationId)?.inputs?.inputParams)
      .toEqual({ keyframe: { timestamp_s: 4.5 } })
  }, testBudget(90_000))
})
