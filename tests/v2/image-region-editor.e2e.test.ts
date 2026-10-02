import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { availablePort, record, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { ObservedToolCall, StartedProcess } from './e2e-harness.js'

describe('drawn region image editor through real MCP', () => {
  let rootDir = ''
  let server: StartedProcess | undefined
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
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'image-region-editor-e2e', version: '1.0.0' }, {
      capabilities: {},
      supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    bookId = String(record(await call('create_book', { name: 'region-editor' }))?.bookId ?? '')
    const notebooks = await call('list_notebooks')
    notebookId = String(record(Array.isArray(notebooks) ? notebooks[0] : null)?.id ?? '')
    for (const [column, background] of ['#b45028', '#2878b4'].entries()) {
      const bytes = await sharp({ create: { width: 300, height: 200, channels: 3, background } }).png().toBuffer()
      const upload = record(await call('upload_file', { filename: `image-${column}.png`, data: bytes.toString('base64') }))
      const assets = record(await call('list_assets'))
      const asset = (Array.isArray(assets?.assets) ? assets.assets : []).map(record)
        .find((entry) => entry?.id === upload?.assetId)
      const cell = record(await call('create_notebook_cell', {
        cell: { type: 'image', slot: { row: 0, column }, output_artifact_id: asset?.artifact_id },
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
    await stopProcess(server)
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
})
