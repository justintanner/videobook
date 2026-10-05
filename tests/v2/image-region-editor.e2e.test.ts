import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import express from 'express'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine } from '../../server/src/book-context.js'
import { createHttpHandler } from '../../server/src/server.js'
import { abortActiveBookJobsForTests, pauseBookQueueForTests, queue, setEngineRoot } from '../../server/src/queue.js'
import { availablePort, record, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { ObservedToolCall, StartedProcess } from './e2e-harness.js'

describe('drawn region image editor through real MCP', () => {
  let rootDir = ''
  let server: Server | undefined
  let books: BookManager
  let vite: StartedProcess | undefined
  let browser: Browser | undefined
  let page: Page
  let client: Client
  let bookId = ''
  let notebookId = ''
  let sourceCellId = ''
  const observed: ObservedToolCall[] = []

  async function call(name: string, args: Record<string, unknown> = {}) {
    return resultValue(await client.callTool({
      name, arguments: { book_id: bookId, notebook_id: notebookId, ...args },
    }))
  }

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-region-editor-'))
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    const origin = `http://127.0.0.1:${mcpPort}`
    const appUrl = `http://127.0.0.1:${vitePort}`
    const env = {
      ...process.env,
      PORT: String(mcpPort),
      KIE_API_KEY: '',
      FAL_API_KEY: '',
      VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
      VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime/app-state.json'),
    }
    books = new BookManager({ libraryDir: env.VIDEOBOOK_LIBRARY_DIR })
    await books.ready()
    const mcp = toNodeHandler(createHttpHandler(scopedBookEngine, books))
    const app = express()
    app.use(express.json())
    app.all('/mcp', (request, response) => { void mcp(request, response, request.body) })
    app.get(/^\/files\/([^/]+)\/([^/]+)\/(.+)$/, async (request, response) => {
      const book = books.get(String(request.params[0]))
      if (!book.ok) { response.sendStatus(404); return }
      const file = await book.value.engine.files.read(String(request.params[1]), String(request.params[2]))
      if (!file.ok) { response.sendStatus(404); return }
      response.type(String(request.params[2])).send(file.value)
    })
    server = createServer(app)
    await new Promise<void>((resolve) => server!.listen(mcpPort, '127.0.0.1', resolve))
    client = new Client({ name: 'image-region-editor-e2e', version: '1.0.0' }, {
      capabilities: {},
      supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    bookId = String(record(await call('create_book', { name: 'region-editor' }))?.bookId ?? '')
    const notebooks = await call('list_notebooks')
    notebookId = String(record(Array.isArray(notebooks) ? notebooks[0] : null)?.id ?? '')
    const book = books.get(bookId)
    if (!book.ok) throw new Error(book.error.message)
    const { engine, rootDir: bookRoot } = book.value
    await setEngineRoot(bookRoot, engine)
    await pauseBookQueueForTests(bookId)
    for (const [column, background] of ['#b45028', '#2878b4'].entries()) {
      const bytes = await sharp({ create: { width: 300, height: 200, channels: 3, background } }).png().toBuffer()
      const asset = await engine.artifacts.create('image', `image-${column}`)
      if (!asset.ok) throw new Error(asset.error.message)
      const written = await engine.files.write(asset.value.artifactId, 'original.png', bytes)
      if (!written.ok) throw new Error(written.error.message)
      const cell = record(await call('create_notebook_cell', {
        cell: { type: 'image', slot: { row: 0, column }, output_artifact_id: asset.value.artifactId },
      }))
      if (column === 0) sourceCellId = String(cell?.id ?? '')
    }
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      ...env,
      VIDEOBOOK_SERVER_URL: origin,
      VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache'),
      VIDEOBOOK_VITE_HMR: '0',
    })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.addInitScript((id) => {
      localStorage.setItem('videobook.active-book', id)
      localStorage.setItem('videobook.cloud-generation-consent', 'accepted')
    }, bookId)
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.postData()?.includes('edit_image_subjects')) {
        observed.push(...toolCalls(request.postDataJSON()).filter((entry) => entry.name === 'edit_image_subjects'))
      }
    })
    await page.goto(appUrl)
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    }
    await queue.stop()
    await books?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('routes prompt edits, removal and replacement to the drawn selection without subject analysis', async () => {
    await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
    await page.getByRole('button', { name: 'Edit @a1 image', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Fullscreen preview for @a1' })
    const instruction = dialog.getByLabel('What should change?')
    const draw = dialog.getByRole('button', { name: 'Draw region', exact: true })
    const drawRegion = async (left: number, top: number, width: number, height: number) => {
      await draw.click()
      const image = await dialog.locator('.notebook-subject-stage-svg > image').boundingBox()
      if (!image) throw new Error('Image stage is missing')
      await page.mouse.move(image.x + image.width * left, image.y + image.height * top)
      await page.mouse.down()
      await page.mouse.move(image.x + image.width * (left + width), image.y + image.height * (top + height), { steps: 5 })
      await page.mouse.up()
      await draw.click()
    }
    const rejectedByProviderConfig = async () => {
      await expect.poll(() => dialog.locator('.image-editor-status.error').textContent())
        .toContain('KIE_API_KEY environment variable is not set')
    }
    await drawRegion(0.1, 0.1, 0.3, 0.4)
    expect(await dialog.getByRole('checkbox', { name: 'Select region 1', exact: true }).isChecked()).toBe(true)
    expect(await dialog.locator('.image-editor-target strong').textContent()).toBe('Region 1')
    await instruction.fill('Remove the glass door but keep the person')
    await dialog.getByRole('button', { name: /Apply edit/ }).click()
    await rejectedByProviderConfig()
    expect(observed[0]?.arguments).toMatchObject({
      operation: 'edit', prompt: 'Remove the glass door but keep the person',
      edit_regions: [{ x: expect.closeTo(0.1, 2), y: expect.closeTo(0.1, 2), width: expect.closeTo(0.3, 2), height: expect.closeTo(0.4, 2) }],
    })
    expect(observed[0]?.arguments).not.toHaveProperty('regions')
    expect(await instruction.inputValue()).toBe('Remove the glass door but keep the person')

    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await rejectedByProviderConfig()
    expect(observed[1]?.arguments).toMatchObject({
      operation: 'remove', edit_regions: observed[0]!.arguments.edit_regions,
      model: 'seedream/5-pro-image-to-image',
    })
    await instruction.fill('')
    await dialog.getByRole('listbox', { name: 'Replacement for Region 1' })
      .getByRole('option', { name: '@a2', exact: true }).click()
    await dialog.getByRole('button', { name: /Replace with image/ }).click()
    await rejectedByProviderConfig()
    expect(observed[2]?.arguments).toMatchObject({
      operation: 'replace', regions: [{ box: (observed[0]!.arguments.edit_regions as unknown[])[0], replacement_artifact_id: expect.any(String) }],
    })
    expect(observed[2]?.arguments).not.toHaveProperty('edit_regions')
    await dialog.getByRole('button', { name: 'Clear replacement for Region 1' }).click()
    expect(await dialog.getByRole('button', { name: /Apply edit/ }).isVisible()).toBe(true)

    await drawRegion(0.6, 0.5, 0.2, 0.3)
    await dialog.getByRole('checkbox', { name: 'Select region 1', exact: true }).uncheck()
    expect(await dialog.locator('.image-editor-target strong').textContent()).toBe('Region 2')
    await instruction.fill('Make this area blue')
    await instruction.press('Control+Enter')
    await rejectedByProviderConfig()
    expect(observed[3]?.arguments).toMatchObject({
      operation: 'edit',
      edit_regions: [{ x: expect.closeTo(0.6, 2), y: expect.closeTo(0.5, 2), width: expect.closeTo(0.2, 2), height: expect.closeTo(0.3, 2) }],
    })
    await page.screenshot({ path: '/tmp/videobook-region-editor-check.png' })
  }, 60_000)

  it('draws regions with touch and clears interrupted gestures on a phone', async () => {
    const phone = await browser!.newPage({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    })
    const requests: ObservedToolCall[] = []
    try {
      await phone.addInitScript((id) => {
        localStorage.setItem('videobook.active-book', id)
        localStorage.setItem('videobook.cloud-generation-consent', 'accepted')
      }, bookId)
      phone.on('request', (request) => {
        if (request.method() === 'POST' && request.postData()?.includes('edit_image_subjects')) {
          requests.push(...toolCalls(request.postDataJSON()).filter((entry) => entry.name === 'edit_image_subjects'))
        }
      })
      await phone.goto(page.url())
      await phone.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).tap()
      await phone.getByRole('button', { name: 'Edit @a1 image', exact: true }).tap()
      const dialog = phone.getByRole('dialog', { name: 'Fullscreen preview for @a1' })
      await dialog.getByRole('button', { name: 'Draw region', exact: true }).tap()
      const touch = await phone.context().newCDPSession(phone)
      const drag = async (cancel: boolean) => {
        const image = await dialog.locator('.notebook-subject-stage-svg > image').boundingBox()
        if (!image) throw new Error('Image stage is missing')
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: image.x + image.width * 0.1, y: image.y + image.height * 0.1 }],
        })
        for (let step = 1; step <= 5; step += 1) {
          await touch.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{
              x: image.x + image.width * (0.1 + step * 0.1),
              y: image.y + image.height * (0.1 + step * 0.12),
            }],
          })
        }
        await touch.send('Input.dispatchTouchEvent', {
          type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [],
        })
      }
      await drag(true)
      expect(await dialog.getByRole('checkbox', { name: 'Select region 1', exact: true }).count()).toBe(0)
      await expect.poll(() => dialog.locator('.notebook-region-draft').count()).toBe(0)
      await drag(false)
      await expect.poll(() => dialog.getByRole('checkbox', { name: 'Select region 1', exact: true }).count()).toBe(1)
      expect(await dialog.getByRole('checkbox', { name: 'Select region 1', exact: true }).isChecked()).toBe(true)
      expect(await dialog.locator('.image-editor-target strong').textContent()).toBe('Region 1')
      await dialog.getByLabel('What should change?').fill('Make this area blue')
      await dialog.getByRole('button', { name: /Apply edit/ }).tap()
      await expect.poll(() => requests.length).toBe(1)
      expect(requests[0]?.arguments).toMatchObject({
        operation: 'edit', prompt: 'Make this area blue',
        edit_regions: [{ x: expect.closeTo(0.1, 2), y: expect.closeTo(0.1, 2), width: expect.closeTo(0.5, 2), height: expect.closeTo(0.6, 2) }],
      })
      await expect.poll(() => dialog.locator('.image-editor-status.error').textContent())
        .toContain('KIE_API_KEY environment variable is not set')
      await touch.detach()
    } finally {
      await phone.close()
    }
  }, 60_000)

  it('remembers instructions across reopening and reload, then reveals the queued generation', async () => {
    const prompt = 'Match the light and preserve the surrounding trees'
    await page.reload()
    await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
    const edit = page.getByRole('button', { name: 'Edit @a1 image', exact: true })
    await edit.click()
    const dialog = page.getByRole('dialog', { name: 'Fullscreen preview for @a1' })
    const instruction = dialog.getByLabel('What should change?')
    await instruction.fill(prompt)
    await instruction.press('Escape')
    await dialog.getByRole('button', { name: 'Edit image', exact: true }).click()
    expect(await instruction.inputValue()).toBe(prompt)
    await dialog.getByRole('button', { name: 'Close fullscreen preview' }).click()
    await edit.click()
    expect(await instruction.inputValue()).toBe(prompt)
    await page.reload()
    await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
    await edit.click()
    expect(await instruction.inputValue()).toBe(prompt)
    await dialog.getByRole('button', { name: 'Close fullscreen preview' }).click()

    await call('move_notebook_cells', { slots: [{ id: sourceCellId, row: 12, column: 0 }] })
    await page.reload()
    await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
    await page.getByRole('button', { name: 'Edit @m1 image', exact: true }).click()
    const movedDialog = page.getByRole('dialog', { name: 'Fullscreen preview for @m1' })
    expect(await movedDialog.getByLabel('What should change?').inputValue()).toBe(prompt)
    await movedDialog.getByRole('button', { name: 'Draw region', exact: true }).click()
    const image = await movedDialog.locator('.notebook-subject-stage-svg > image').boundingBox()
    if (!image) throw new Error('Missing image stage')
    await page.mouse.move(image.x + image.width * 0.1, image.y + image.height * 0.1)
    await page.mouse.down()
    await page.mouse.move(image.x + image.width * 0.5, image.y + image.height * 0.5, { steps: 5 })
    await page.mouse.up()
    await movedDialog.getByRole('listbox', { name: 'Replacement for Region 1' })
      .getByRole('option', { name: '@a2', exact: true }).click()
    await page.locator('.notebook-horizontal-scroll').evaluate((node) => { node.scrollTop = 0 })
    const originalKey = process.env.KIE_API_KEY
    process.env.KIE_API_KEY = 'test-key'
    try {
      await movedDialog.getByRole('button', { name: /Replace with image/ }).click()
      await movedDialog.waitFor({ state: 'hidden', timeout: 15_000 })
      const notebook = record(await call('get_notebook'))
      const cells = (Array.isArray(notebook?.cells) ? notebook.cells : []).map(record)
      const producer = cells.find((cell) => cell?.type === 'generate_image')
      expect(producer?.prompt).toContain(prompt)
      const generation = page.locator(`.react-flow__node[data-id="${String(producer?.id)}"]`)
      await expect.poll(() => generation.getAttribute('class')).toContain('selected')
      expect(await page.locator('.react-flow__node.selected').count()).toBe(1)
      await expect.poll(() => generation.evaluate((node) => {
        const bounds = node.getBoundingClientRect()
        const scroll = document.querySelector('.notebook-horizontal-scroll')
        const composer = document.querySelector('.command-composer')
        if (!scroll || !composer) return false
        return bounds.top >= scroll.getBoundingClientRect().top
          && bounds.bottom <= composer.getBoundingClientRect().top + 2
      })).toBe(true)
      expect(await page.locator('.app-shell').evaluate((node) => (node as HTMLElement).inert)).toBe(false)
      await page.screenshot({ path: '/tmp/videobook-region-generation-focus.png' })
      await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
      await page.getByRole('button', { name: 'Edit @m1 image', exact: true }).click()
      expect(await movedDialog.getByLabel('What should change?').inputValue()).toBe(prompt)
      await movedDialog.getByLabel('What should change?').fill('')
      await page.reload()
      await page.locator(`.react-flow__node[data-id="${sourceCellId}"] .cell-node`).click()
      await page.getByRole('button', { name: 'Edit @m1 image', exact: true }).click()
      expect(await movedDialog.getByLabel('What should change?').inputValue()).toBe('')
    } finally {
      if (originalKey === undefined) delete process.env.KIE_API_KEY
      else process.env.KIE_API_KEY = originalKey
      await abortActiveBookJobsForTests()
    }
  }, 60_000)
})
