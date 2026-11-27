import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page, Route } from 'playwright'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { availablePort, record, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness.js'
import { selectGenerationAction } from './generation-picker-e2e.js'
import type { StartedProcess } from './e2e-harness.js'
import type { WorkspaceActionCatalog } from '../../server/src/workspace-action-contract.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { testBudget } from '../../server/src/test-budget.js'

const MCP_ROUNDTRIP_MS = 15_000

describe('workspace action launcher with real endpoints', () => {
  let rootDir = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser
  let client: Client
  let page: Page
  let appUrl = ''
  let bookId = ''
  let catalog: WorkspaceActionCatalog
  let notebookId = ''
  let videoId = ''
  let imageId = ''
  let origin = ''
  let browserErrors: string[] = []
  let commandResponses: unknown[] = []
  let navigations: string[] = []

  async function sendCommand(value: string): Promise<void> {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => page.locator('.command-send .busy-indicator').count(), { timeout: MCP_ROUNDTRIP_MS }).toBe(0)
    await input.fill(value)
    if (await page.locator('.command-suggestions').isVisible()) await input.press('Escape')
    await input.press('Enter')
    await expect.poll(() => input.isEnabled(), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => page.locator('.command-send .busy-indicator').count(), { timeout: 15_000 }).toBe(0)
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return resultValue(await client.callTool({ name, arguments: { book_id: bookId, ...args } }))
  }

  async function originalImageFile(): Promise<string> {
    const manifest = record(await call('asset_manifest', { asset_id: imageId }))!
    const filename = (manifest.files as Record<string, unknown>[]).find(file => /^original\.(?:png|jpe?g)$/u.test(String(file.name)))?.name
    expect(typeof filename).toBe('string')
    return String(filename)
  }

  async function originalImageBytes(): Promise<Buffer> {
    const response = await fetch(`${origin}/files/${bookId}/${imageId}/${await originalImageFile()}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^image\//u)
    return Buffer.from(await response.arrayBuffer())
  }

  const COMPOSER_SHEET_ACTIONS: Readonly<Record<string, string>> = {
    'command.post': 'Select a clip or a Post cell',
    'tool.transcribe': 'Choose a video or audio clip',
  }

  async function openActions(command?: string): Promise<void> {
    await page.getByRole('button', { name: 'Open actions', exact: true }).click()
    await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(100)
    if (!command) return
    await page.getByLabel('Videobook command input', { exact: true }).fill(command)
    await page.locator(`[data-command="${command}"]`).click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await page.locator('.command-composer .confirm-sheet form.workspace-action-form').waitFor()
  }

  async function applySheet(label: 'Run action'): Promise<void> {
    const apply = page.locator('.command-composer .confirm-sheet-apply')
    await expect.poll(() => apply.textContent(), { timeout: MCP_ROUNDTRIP_MS }).toContain(label)
    await expect.poll(() => apply.isEnabled(), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
    await apply.click()
  }

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-workspace-actions-'))
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    origin = `http://127.0.0.1:${mcpPort}`
    appUrl = `http://127.0.0.1:${vitePort}`
    const env = {
      ...process.env, PORT: String(mcpPort), OPENAI_API_KEY: '', KIE_API_KEY: 'test-workspace-actions-e2e', FAL_API_KEY: 'test-workspace-actions-e2e',
      KIMI_CODING_API_KEY: '', DASHSCOPE_API_KEY: '', ELEVENLABS_API_KEY: '',
      VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'), VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime/app-state.json'),
      VIDEOBOOK_DOWNLOADS_DIR: join(rootDir, 'downloads'), X_CLIENT_ID: '', X_CLIENT_SECRET: '', XAI_API_KEY: '',
    }
    await mkdir(join(rootDir, 'downloads'))
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'workspace-action-ui-e2e', version: '1.0.0' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    const book = record(await call('create_book', { name: 'action-ui-project' }))
    bookId = String(book?.bookId ?? '')
    const notebooks = await call('list_notebooks')
    notebookId = String(record(Array.isArray(notebooks) ? notebooks[0] : null)?.id ?? '')
    const videoPath = join(rootDir, 'video.mp4')
    const imagePath = join(rootDir, 'image.png')
    await promisify(execFile)(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath])
    await promisify(execFile)(FFMPEG, ['-y', '-i', videoPath, '-frames:v', '1', imagePath])
    videoId = String(record(await call('upload_file', { filename: 'action-video.mp4', data: (await readFile(videoPath)).toString('base64') }))?.assetId)
    imageId = String(record(await call('upload_file', { filename: 'action-image.png', data: (await readFile(imagePath)).toString('base64') }))?.assetId)
    await call('create_notebook_cell', { notebook_id: notebookId, cell: { type: 'video', slot: { row: 0, column: 0 }, output_artifact_id: videoId } })
    await call('create_notebook_cell', { notebook_id: notebookId, cell: { type: 'image', slot: { row: 0, column: 1 }, output_artifact_id: imageId } })
    catalog = await call('list_workspace_actions', { detail: 'full' }) as WorkspaceActionCatalog
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
    })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
  }, 60_000)

  beforeEach(async () => {
    browserErrors = []
    commandResponses = []
    navigations = []
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()) })
    page.on('pageerror', error => browserErrors.push(error.message))
    page.on('response', async response => {
      const request = response.request()
      if (!request.url().endsWith('/mcp') || request.method() !== 'POST') return
      const payload = record(request.postDataJSON())
      const params = record(payload?.params)
      if (!['plan_sequence_export', 'enqueue_sequence_export', 'preview_edit_intent', 'apply_command_plan', 'search_library_assets'].includes(String(params?.name))) return
      commandResponses.push({ request: payload, response: await response.text().catch(() => 'unavailable') })
    })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: testBudget(60_000) })
    await expect.poll(() => page.getByLabel('Open actions', { exact: true }).isEnabled(), { timeout: testBudget(MCP_ROUNDTRIP_MS) }).toBe(true)
  }, testBudget(90_000))

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      const evidencePath = `/tmp/videobook-actions-${task.name.replace(/[^a-z0-9]+/giu, '-').slice(0, 90)}`
      await page.screenshot({ path: `${evidencePath}.png` })
      await writeFile(`${evidencePath}.txt`, await page.locator('body').innerText())
      await writeFile(`${evidencePath}.aria.txt`, await page.locator('body').ariaSnapshot())
      await writeFile(`${evidencePath}.json`, JSON.stringify({ browserErrors, commandResponses, navigations, focus: await page.evaluate(() => document.activeElement?.outerHTML) }, null, 2))
    }
    await page?.close()
  })
  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('recovers failed downloads in place by retrying the URL or choosing a saved video', async () => {
    const video = await readFile(join(rootDir, 'video.mp4'))
    let available = false
    const source = createServer((_request, response) => {
      if (!available) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length }).end(video)
    })
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
    try {
      const address = source.address()
      if (!address || typeof address === 'string') throw new Error('Missing video source port')
      const url = `http://127.0.0.1:${address.port}/clip.mp4`
      const notebook = await call('create_notebook', { name: 'Download recovery' }) as { id: string }
      const cells: Array<{ id: string; output_artifact_id: string }> = []
      for (const column of [0, 1]) {
        const download = await call('download_video', { url }) as { artifact_id: string; job_id: string }
        const cell = await call('create_notebook_cell', { notebook_id: notebook.id, cell: {
          type: 'video', slot: { row: 0, column }, output_artifact_id: download.artifact_id,
          inputs: { sourceOperation: 'download_video', sourceUrl: url, jobId: download.job_id },
        } }) as { id: string; output_artifact_id: string }
        cells.push(cell)
      }
      const rows = async () => (await call('list_assets') as {
        assets: Array<{ artifact_id: string; status: string; failedDownload?: { jobId: number } }>
      }).assets.filter(row => cells.some(cell => cell.output_artifact_id === row.artifact_id))
      await expect.poll(async () => (await rows()).filter(row => row.failedDownload).length, { timeout: testBudget(60_000) }).toBe(2)
      const fileCell = cells[1]!
      const oldJobId = (await rows()).find(row => row.artifact_id === fileCell.output_artifact_id)!.failedDownload!.jobId
      await page.evaluate(([book, id]) => localStorage.setItem(`videobook.active-notebook:${book}`, id!), [bookId, notebook.id])
      await page.reload()
      available = true
      await page.getByRole('button', { name: 'Retry @a1', exact: true }).click()
      await page.locator(`[data-id="${fileCell.id}"] .cell-node-footer strong`).click()
      const recovery = page.getByRole('region', { name: 'Download recovery' })
      await recovery.waitFor({ state: 'visible' })
      await expect.poll(() => recovery.getByRole('button', { name: 'Retry download' }).isEnabled(), { timeout: testBudget(MCP_ROUNDTRIP_MS) }).toBe(true)
      const choose = async (buffer: Buffer) => {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          recovery.getByRole('button', { name: 'Choose video file' }).click(),
        ])
        const result = page.waitForResponse(response => response.url().includes(`failedDownloadJobId=${oldJobId}`))
        await chooser.setFiles({ name: 'saved.mp4', mimeType: 'video/mp4', buffer })
        return (await result).status()
      }
      expect(await choose(Buffer.from('invalid video bytes'))).toBe(400)
      expect(await choose(video)).toBe(200)
      await expect.poll(async () => (await rows()).map(row => row.status), { timeout: testBudget(60_000) }).toEqual(['ready', 'ready'])
      await recovery.waitFor({ state: 'hidden' })
      const graph = await call('get_notebook', { notebook_id: notebook.id }) as { cells: Array<{ id: string; output_artifact_id: string }> }
      expect(graph.cells.map(cell => [cell.id, cell.output_artifact_id])).toEqual(cells.map(cell => [cell.id, cell.output_artifact_id]))
      for (const cell of graph.cells) {
        const original = await fetch(`${origin}/files/${bookId}/${cell.output_artifact_id}/original.mp4`)
        expect(Buffer.from(await original.arrayBuffer()).equals(video)).toBe(true)
      }
      const query = new URLSearchParams({ targetAssetId: fileCell.output_artifact_id, filename: 'repeat.mp4', failedDownloadJobId: String(oldJobId) })
      expect((await fetch(`${origin}/api/books/${bookId}/upload?${query}`, { method: 'POST', body: video })).status).toBe(409)
      await expect(call('retry_job', { job_id: oldJobId })).rejects.toThrow('download has changed')
    } finally {
      await new Promise<void>(resolve => source.close(() => resolve()))
    }
  }, testBudget(120_000))

  it('keeps new downloads in view above the composer, even with a preview open', async () => {
    const video = await readFile(join(rootDir, 'video.mp4'))
    const source = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length }).end(video)
    })
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
    try {
      const address = source.address()
      if (!address || typeof address === 'string') throw new Error('Missing video source port')
      const notebook = await call('create_notebook', { name: 'Download focus' }) as { id: string }
      await page.evaluate(([book, id]) => localStorage.setItem(`videobook.active-notebook:${book}`, id!), [bookId, notebook.id])
      await page.reload()
      await expect.poll(() => page.getByLabel('Open actions', { exact: true }).isEnabled(), { timeout: testBudget(MCP_ROUNDTRIP_MS) }).toBe(true)
      const scroll = page.locator('.notebook-horizontal-scroll')
      const cellIds = async () => (await call('get_notebook', { notebook_id: notebook.id }) as { cells: Array<{ id: string }> }).cells.map(cell => cell.id)
      const settledPlacement = (cellId: string) => scroll.evaluate((element, id) => new Promise<{ topGap: number; bottomGap: number } | null>((resolve) => {
        let last = element.scrollTop
        let still = 0
        const step = () => {
          still = element.scrollTop === last ? still + 1 : 0
          last = element.scrollTop
          if (still < 20) return requestAnimationFrame(step)
          const tile = element.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect()
          const composer = document.querySelector('.command-composer')!.getBoundingClientRect()
          const viewport = element.getBoundingClientRect()
          resolve(tile ? { topGap: tile.top - viewport.top, bottomGap: composer.top - tile.bottom } : null)
        }
        requestAnimationFrame(step)
      }), cellId)
      const expectInView = async (cellId: string) => {
        await expect.poll(async () => {
          const gaps = await settledPlacement(cellId)
          return gaps !== null && gaps.topGap >= 0 && gaps.bottomGap >= 0
        }, { timeout: testBudget(MCP_ROUNDTRIP_MS) }).toBe(true)
        await page.waitForTimeout(1_000)
        const gaps = await settledPlacement(cellId)
        expect(gaps?.topGap).toBeGreaterThanOrEqual(0)
        expect(gaps?.bottomGap).toBeGreaterThanOrEqual(0)
      }

      await sendCommand(`/download http://127.0.0.1:${address.port}/first.mp4`)
      await expect.poll(async () => (await cellIds()).length, { timeout: testBudget(MCP_ROUNDTRIP_MS) }).toBe(1)
      const [firstId] = await cellIds()
      await expectInView(firstId!)
      expect(await page.locator(`[data-id="${firstId}"] .cell-node-footer strong`).textContent()).toBe('@a1')

      await page.locator(`[data-id="${firstId}"] .cell-node-body`).click()
      await page.locator('.command-composer .inspector-media-row-content').waitFor({ state: 'visible', timeout: testBudget(MCP_ROUNDTRIP_MS) })
      await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
      expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

      const pendingTile = page.locator('.cell-node[data-pending="true"][data-cell-status="downloading"]')
      let pendingAddress: string | null = null
      const watchDownload = async (route: Route) => {
        if ((route.request().postData() ?? '').includes('"download_video"')) {
          await pendingTile.waitFor({ state: 'visible', timeout: testBudget(MCP_ROUNDTRIP_MS) })
          pendingAddress = await pendingTile.locator('.cell-node-footer strong').textContent()
        }
        await route.fallback()
      }
      await page.route('**/mcp', watchDownload)
      try {
        await sendCommand(`/download http://127.0.0.1:${address.port}/second.mp4`)
      } finally {
        await page.unroute('**/mcp', watchDownload)
      }
      await expect.poll(async () => (await cellIds()).length, { timeout: testBudget(MCP_ROUNDTRIP_MS) }).toBe(2)
      const secondId = (await cellIds()).find(id => id !== firstId)!
      await expectInView(secondId)
      expect(pendingAddress).toBe('@a2')
      expect(await page.locator(`[data-id="${secondId}"] .cell-node-footer strong`).textContent()).toBe(pendingAddress)
      expect(await page.locator('.cell-node[data-pending="true"]').count()).toBe(0)
    } finally {
      await new Promise<void>(resolve => source.close(() => resolve()))
    }
  }, testBudget(120_000))

  it('lists the complete endpoint catalog and traverses past twelve options with the keyboard', async () => {
    await openActions()
    const options = page.locator('.workspace-actions-list [role="option"]')
    expect(await options.count()).toBe(catalog.actions.length)
    expect((await options.evaluateAll(elements => elements.map(element => element.getAttribute('data-action-id')))).sort())
      .toEqual(catalog.actions.map(action => action.id).sort())
    const search = page.getByLabel('Videobook command input', { exact: true })
    await search.focus()
    const visited = new Set<string>()
    for (let index = 0; index < 30; index += 1) {
      await page.keyboard.press('ArrowDown')
      visited.add(await search.getAttribute('aria-activedescendant') ?? '')
    }
    expect(visited.size).toBe(30)
    const current = page.locator('.workspace-actions-list [aria-selected="true"]')
    expect(await current.evaluate(element => {
      const parent = element.parentElement!.getBoundingClientRect()
      const rect = element.getBoundingClientRect()
      return rect.top >= parent.top && rect.bottom <= parent.bottom
    })).toBe(true)
    await search.fill('')
    await page.screenshot({ path: '/tmp/videobook-actions-desktop.png' })
    await search.fill('/unassign')
    expect(await options.count()).toBe(1)
    expect(await options.first().getAttribute('data-command')).toBe('/delete')
    await search.fill('/status')
    expect(await page.locator('[data-command="/activity"]').count()).toBe(1)
  })

  it('runs an actual read and creates a reusable prompt through typed fields', async () => {
    await openActions('/get-book')
    await applySheet('Run action')
    await expect.poll(() => page.getByLabel('Action result', { exact: true }).textContent(), { timeout: MCP_ROUNDTRIP_MS }).toContain('action-ui-project')
    await page.getByRole('button', { name: 'All actions', exact: true }).click()
    const createPrompt = catalog.actions.find(action => action.command === '/prompt-new')!
    await page.getByLabel('Videobook command input', { exact: true }).fill(createPrompt.command)
    await page.locator(`[data-action-id="${createPrompt.id}"]`).click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await page.getByLabel('Name', { exact: false }).fill('A reusable shot')
    await page.getByLabel('Prompt', { exact: true }).fill('A slow pan across a quiet lake')
    await applySheet('Run action')
    await expect.poll(async () => JSON.stringify(await call('list_entities', { kind: 'prompt' })), { timeout: MCP_ROUNDTRIP_MS }).toContain('A slow pan across a quiet lake')
    await page.getByLabel('Action result', { exact: true }).waitFor()
    await page.screenshot({ path: '/tmp/videobook-actions-prompt.png' })
  })

  it.each([0, 1, 2, 3])('opens a typed form for every catalog action without starting mutations (batch %i)', async (batch) => {
    await openActions()
    for (const action of catalog.actions.filter((_, index) => index % 4 === batch)) {
      const search = page.getByLabel('Videobook command input', { exact: true })
      await search.fill(action.command)
      await page.locator(`.workspace-actions-list [data-action-id="${action.id}"]`).click()
      await page.getByRole('button', { name: 'Send command', exact: true }).click()
      const sheetOutcome = COMPOSER_SHEET_ACTIONS[action.id]
      if (sheetOutcome) {
        await expect.poll(() => page.getByText(sheetOutcome, { exact: false }).count(), { timeout: MCP_ROUNDTRIP_MS }).toBeGreaterThan(0)
        expect(await page.locator('form.workspace-action-form').count(), action.id).toBe(0)
        await openActions()
        continue
      }
      await page.locator(`form.workspace-action-form[data-action-id="${action.id}"]`).waitFor()
      expect(await page.locator('.command-composer .confirm-sheet-apply').textContent(), action.id).toBe('Run action ↵')
      await page.getByRole('button', { name: 'All actions', exact: true }).click()
    }
    expect(browserErrors).toEqual([])
  }, 300_000)

  it('opens from Library at phone widths and keeps shared action search inside the viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByLabel('Open Assets', { exact: true }).click()
    await openActions()
    const dialog = page.locator('.composer-actions-panel')
    expect(await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
    })).toBe(true)
    await page.getByLabel('Videobook command input', { exact: true }).fill('generate fal')
    await page.screenshot({ path: '/tmp/videobook-actions-mobile.png' })
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.setViewportSize({ width: 320, height: 844 })
    expect(await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth
    })).toBe(true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Videobook command input')
  })

  it('traverses the entire slash list and invokes exact aliases and sequence commands', async () => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await input.fill('/')
    await expect.poll(async () => (await page.locator('.command-suggestions strong').allTextContents()).sort())
      .toEqual([...catalog.actions.map(action => action.command), '/action-ui-project'].sort())
    expect(await input.getAttribute('role')).toBe('combobox')
    const visited = new Set<string>()
    for (let index = 0; index < 30; index += 1) {
      await input.press('ArrowDown')
      visited.add(await input.getAttribute('aria-activedescendant') ?? '')
    }
    expect(visited.size).toBe(30)
    await input.press('End')
    const selected = page.locator('.command-suggestions [aria-selected="true"]')
    expect(await selected.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const parent = element.parentElement!.getBoundingClientRect()
      return rect.top >= parent.top && rect.bottom <= parent.bottom
    })).toBe(true)
    await input.fill('/unassign')
    expect(await page.locator('.command-suggestions strong').allTextContents()).toContain('/delete')
    await input.fill('/status')
    expect(await page.locator('.command-suggestions strong').allTextContents()).toContain('/activity')
    await input.press('Enter')
    const activity = page.getByRole('heading', { level: 2, name: 'List book actions' })
    await activity.waitFor()
    await expect.poll(async () => {
      await input.press('Escape')
      return await activity.isVisible()
    }, { timeout: MCP_ROUNDTRIP_MS }).toBe(false)
    await input.fill('/insert')
    await expect.poll(() => page.locator('.command-suggestions [role="option"][aria-selected="true"] strong').textContent(), { timeout: MCP_ROUNDTRIP_MS }).toBe('/insert')
    await input.press('Enter')
    await page.getByRole('heading', { level: 2, name: 'Insert', exact: true }).waitFor()
    expect(await page.getByLabel('Start frame', { exact: false }).getAttribute('type')).toBe('number')
    await page.keyboard.press('Escape')
    await sendCommand('/track-add audio Action soundtrack')
    await expect.poll(async () => JSON.stringify(await call('get_primary_sequence')), { timeout: MCP_ROUNDTRIP_MS }).toContain('Action soundtrack')
  })

  it('opens edit forms from slash and cell menus, and keeps actions available while browsing Library', async () => {
    await sendCommand('/crop @a2')
    await page.getByRole('heading', { level: 2, name: 'Crop asset', exact: true }).waitFor()
    expect(await page.getByRole('dialog', { name: 'Workspace action review' }).getByRole('combobox', { name: /^Media/u }).inputValue()).toBe(imageId)
    await page.keyboard.press('Escape')
    await page.getByLabel('Open @a2 cell menu', { exact: true }).click()
    const menu = page.getByRole('menu')
    const labels = (await menu.getByRole('menuitem').allTextContents())
      .map((label) => label.replace('⌫', '').trim())
    expect(labels.at(-1)).toContain('Delete')
    expect(labels).not.toContain('More actions')
    await page.keyboard.press('Escape')
    await page.getByLabel('Open Assets', { exact: true }).click()
    await page.getByRole('region', { name: 'Choose library media' }).waitFor({ state: 'visible' })
    await openActions('/rename')
    expect(await page.getByRole('dialog', { name: 'Workspace action review' }).getByRole('combobox', { name: /^Media/u }).count()).toBe(1)
  })

  it('edits and deletes a saved prompt using its name while preserving its identity', async () => {
    const entity = record(await call('create_entity', { kind: 'prompt', name: 'Editable prompt', prompt: 'Before edit', description: 'Keep this description' }))!
    await openActions('/update-entity')
    await page.getByLabel('Saved item', { exact: true }).selectOption(String(entity.id))
    await page.getByLabel('Prompt', { exact: true }).fill('After edit')
    await applySheet('Run action')
    await expect.poll(async () => record(await call('get_entity', { entity_id: entity.id }))?.prompt, { timeout: MCP_ROUNDTRIP_MS }).toBe('After edit')
    expect(record(await call('get_entity', { entity_id: entity.id }))?.description).toBe('Keep this description')
    await page.keyboard.press('Escape')
    await openActions('/delete-entity')
    await page.getByRole('combobox', { name: /^Entity\b/u }).selectOption(String(entity.id))
    expect(JSON.stringify(await call('list_entities', { kind: 'prompt' }))).toContain('Editable prompt')
    await applySheet('Run action')
    await expect.poll(async () => JSON.stringify(await call('list_entities', { kind: 'prompt' })), { timeout: MCP_ROUNDTRIP_MS }).not.toContain('Editable prompt')
  })

  it('exports an asset to isolated Downloads without entering the sequence export flow', async () => {
    await sendCommand('/download @a2')
    await expect.poll(async () => (await readdir(join(rootDir, 'downloads'))).length, { timeout: MCP_ROUNDTRIP_MS }).toBe(1)
    const [filename] = await readdir(join(rootDir, 'downloads'))
    const exported = await readFile(join(rootDir, 'downloads', filename!))
    const original = await originalImageBytes()
    expect(exported.equals(original)).toBe(true)
    expect(await page.getByRole('dialog', { name: 'Workspace action review' }).count()).toBe(0)
  })

  it('switches the generation model while retaining the draft and reviews cost without generating', async () => {
    const action = catalog.actions.find(entry => entry.id === 'tool.generate_image')!
    const listed = record(await call('list_generation_models', { media: 'image' }))
    const models = (listed?.models as Record<string, unknown>[]).filter(model => model.available === true)
    const modelId = String(models.find(model => typeof model.id === 'string')?.id ?? '')
    expect(modelId).not.toBe('')
    await openActions(action.command)
    const prompt = page.getByRole('textbox', { name: /^Prompt\b/u })
    await prompt.fill('Keep the same scene and use a watercolor style')
    const sheet = page.locator('form.workspace-action-form')
    const model = sheet.getByLabel('Generation model', { exact: true })
    await expect.poll(() => model.locator('option').count(), { timeout: MCP_ROUNDTRIP_MS }).toBeGreaterThan(1)
    await selectGenerationAction(sheet, modelId)
    expect(await sheet.getByLabel('Generation provider', { exact: true }).inputValue()).toBe(modelId)
    expect(await prompt.inputValue()).toBe('Keep the same scene and use a watercolor style')
    const before = JSON.stringify(await call('list_jobs'))
    const cost = page.locator('.workspace-action-review strong')
    await expect.poll(() => cost.textContent(), { timeout: MCP_ROUNDTRIP_MS }).toMatch(/^(?:Estimated cost: \$\d+\.\d{4}|Cost estimate unavailable)$/u)
    expect(await page.locator('.command-composer .confirm-sheet-apply').textContent()).toBe('Run action ↵')
    expect(await page.locator('.command-composer .confirm-sheet-apply').isEnabled()).toBe(true)
    expect(JSON.stringify(await call('list_jobs'))).toBe(before)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '/tmp/videobook-actions-provider-review.png' })
  })

  it('reviews video graphics and subtitles by the chosen operation without the cost adapter text', async () => {
    const before = JSON.stringify(await call('list_jobs'))
    const sheet = page.getByRole('dialog', { name: 'Workspace action review' })
    const effect = page.locator('.command-composer .confirm-sheet-effect')
    const review = sheet.locator('.workspace-action-review')
    const choose = async (field: string, label: string) => sheet.getByRole('combobox', { name: new RegExp(`^${field}\\b`, 'u') }).selectOption({ label })
    await openActions('/video-graphics')
    await sheet.getByRole('combobox', { name: /^Media/u }).selectOption(videoId)
    expect(await effect.count()).toBe(0)
    await choose('Op', 'suggest')
    await expect.poll(() => effect.textContent()).toBe('May incur provider charges')
    await expect.poll(() => review.locator('strong').textContent(), { timeout: MCP_ROUNDTRIP_MS }).toBe('Cost estimate unavailable')
    expect(await review.locator('p').textContent()).toBe('Running this sends your prompt and selected media to a generation provider and may incur charges.')
    await choose('Op', 'delete_template')
    await expect.poll(() => effect.textContent()).toBe('Changes or removes content')
    await expect.poll(() => review.locator('p').textContent()).toBe('Video graphics changes or removes the selected content.')
    await choose('Op', 'render')
    await expect.poll(() => effect.count()).toBe(0)
    await expect.poll(() => review.count()).toBe(0)
    await choose('Output', 'replace')
    await expect.poll(() => effect.textContent()).toBe('Changes or removes content')
    await choose('Op', 'check_placement')
    await expect.poll(() => effect.count()).toBe(0)
    await page.getByRole('button', { name: 'All actions', exact: true }).click()
    await page.getByLabel('Videobook command input', { exact: true }).fill('/caption-video')
    await page.locator('[data-command="/caption-video"]').click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await page.locator('form.workspace-action-form[data-action-id="tool.caption_video"]').waitFor()
    expect(await effect.count()).toBe(0)
    await choose('Op', 'prepare')
    await expect.poll(() => effect.textContent()).toBe('May incur provider charges')
    await expect.poll(() => review.locator('strong').textContent(), { timeout: MCP_ROUNDTRIP_MS }).toBe('Cost estimate unavailable')
    await choose('Op', 'update')
    await choose('Resolve', 'discard')
    await expect.poll(() => effect.textContent()).toBe('Changes or removes content')
    expect(await page.locator('.command-composer').textContent()).not.toContain('no cost adapter')
    expect(JSON.stringify(await call('list_jobs'))).toBe(before)
    expect(browserErrors).toEqual([])
  })

  it('crops an image through visible controls and persists a square result', async () => {
    const original = await originalImageBytes()
    await sendCommand('/crop @a2')
    await page.getByRole('button', { name: 'Square 1:1', exact: true }).click()
    expect(await page.getByRole('spinbutton', { name: /^W\b/u }).inputValue()).toBe('0.75')
    await applySheet('Run action')
    await expect.poll(async () => {
      const payload = record(await call('list_assets'))
      const asset = (Array.isArray(payload?.assets) ? payload.assets : []).map(record).find(entry => entry?.artifact_id === imageId)
      return [asset?.width, asset?.height]
    }, { timeout: 30_000 }).toEqual([1080, 1080])
    const cropped = await originalImageBytes()
    expect(cropped.equals(original)).toBe(false)
    expect(await sharp(cropped).metadata()).toMatchObject({ width: 1080, height: 1080 })
    await page.screenshot({ path: '/tmp/videobook-actions-crop-result.png' })
  })

  it('preserves multiple-selection and fullscreen targets through their action controls', async () => {
    const square = await page.locator('.notebook-grid-square').filter({ has: page.locator('.notebook-grid-square-label', { hasText: /^@a3$/u }) }).boundingBox()
    if (!square) throw new Error('The empty @a3 slot is missing')
    await page.mouse.click(square.x + square.width / 2, square.y + square.height / 2, { button: 'right' })
    const slotMenu = page.getByRole('menu', { name: 'Slot actions for @a3', exact: true })
    await slotMenu.waitFor()
    expect(await slotMenu.getByRole('menuitem', { name: 'More actions', exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await slotMenu.waitFor({ state: 'hidden' })
    const composer = page.locator('.command-composer')
    if (await composer.getAttribute('data-dock-open') === 'true') {
      await composer.locator('[data-composer-dock-hide]').click()
      await expect.poll(() => composer.getAttribute('data-dock-open')).toBe('false')
    }
    const document = record(await call('get_notebook', { notebook_id: notebookId }))!
    const cells = document.cells as Record<string, unknown>[]
    const selectedIds = cells.filter(cell => record(cell.slot)?.row === 0 && Number(record(cell.slot)?.column) < 2).map(cell => String(cell.id))
    await page.locator(`[data-id="${selectedIds[0]}"] .cell-node-footer strong`).click()
    await page.locator(`[data-id="${selectedIds[1]}"] .cell-node-footer strong`).click({ modifiers: ['Shift'] })
    await page.keyboard.press('Control+Shift+K')
    const run = catalog.actions.find(action => action.id === 'tool.run_notebook')!
    await page.getByLabel('Videobook command input', { exact: true }).fill(run.command)
    await page.locator('.workspace-actions-list [data-action-id="tool.run_notebook"]').click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    const targets = page.getByRole('group', { name: 'Cell ids', exact: true }).locator('select')
    await expect.poll(() => targets.count(), { timeout: MCP_ROUNDTRIP_MS }).toBe(2)
    const selected = await targets.evaluateAll(elements => elements.map(element => (element as HTMLSelectElement).value))
    expect(selected.sort()).toEqual(selectedIds.sort())
    await page.keyboard.press('Escape')
    await page.locator(`[data-id="${selectedIds[0]}"] .cell-node-footer strong`).click()
    await page.getByLabel('Open @a1 cell menu', { exact: true }).click()
    await page.getByRole('menuitem', { name: 'Open media', exact: true }).click()
    const fullscreen = page.getByRole('dialog', { name: 'Fullscreen preview for @a1', exact: true })
    await fullscreen.waitFor()
    expect(await fullscreen.locator('.command-composer').count()).toBe(0)
    await page.keyboard.press('Control+Shift+K')
    await page.getByLabel('Videobook command input', { exact: true }).fill('/asset-manifest')
    await page.locator('.workspace-actions-list [data-action-id="tool.asset_manifest"]').click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    expect(await page.getByRole('dialog', { name: 'Workspace action review' }).getByRole('combobox', { name: 'Media', exact: true }).inputValue()).toBe(videoId)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })

  it('creates, opens, renames and deletes a notebook through the action controls', async () => {
    await page.keyboard.press('Control+Shift+K')
    await page.getByLabel('Videobook command input', { exact: true }).fill('/create-notebook')
    await page.locator('.workspace-actions-list [data-action-id="tool.create_notebook"]').click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('A managed notebook')
    await applySheet('Run action')
    await expect.poll(async () => JSON.stringify(await call('list_notebooks')), { timeout: MCP_ROUNDTRIP_MS }).toContain('A managed notebook')
    const created = (await call('list_notebooks') as Record<string, unknown>[]).find(entry => entry.name === 'A managed notebook')!
    await page.keyboard.press('Escape')
    await openActions(catalog.actions.find(action => action.id === 'tool.list_notebooks')!.command)
    await page.locator('.workspace-action-linked-results li').filter({ hasText: 'A managed notebook' }).getByRole('button', { name: 'Open notebook', exact: true }).click()
    await applySheet('Run action')
    await page.getByRole('dialog', { name: 'Workspace action review' }).waitFor({ state: 'hidden' })
    expect(await page.evaluate(id => localStorage.getItem(`videobook.active-notebook:${id}`), bookId)).toBe(created.id)
    await openActions('/rename-notebook')
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Managed notebook renamed')
    await applySheet('Run action')
    await expect.poll(async () => JSON.stringify(await call('list_notebooks')), { timeout: MCP_ROUNDTRIP_MS }).toContain('Managed notebook renamed')
    await page.keyboard.press('Escape')
    await openActions('/delete-notebook')
    expect(JSON.stringify(await call('list_notebooks'))).toContain(String(created.id))
    await applySheet('Run action')
    await expect.poll(async () => JSON.stringify(await call('list_notebooks')), { timeout: MCP_ROUNDTRIP_MS }).not.toContain(String(created.id))
    expect(await page.getByRole('alert').count()).toBe(0)
  })

  it('rejects an export when the cut changes after its review', async () => {
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: videoId }] })
    await page.reload()
    await sendCommand('/export-sequence --captions omit')
    await expect.poll(() => page.getByLabel('Videobook command input', { exact: true }).textContent()).toBe('/apply')
    await call('add_sequence_track', { kind: 'audio', name: 'Changed after review' })
    await sendCommand('/apply')
    await page.getByText(/The sequence changed after review\. Review the current cut before exporting\./u).first().waitFor()
    expect(commandResponses.some(entry => record(record(record(entry)?.request)?.params)?.name === 'enqueue_sequence_export')).toBe(false)
    await sendCommand('/cancel')
  })

  it('previews a book revision directly from its named history entry', async () => {
    await expect.poll(async () => {
      const value = record(await call('list_jobs'))
      return (value?.jobs as Record<string, unknown>[] ?? []).every(job => ['completed', 'succeeded', 'failed', 'cancelled', 'aborted'].includes(String(job.status)))
    }, { timeout: 30_000 }).toBe(true)
    const history = record(await call('list_book_actions'))!
    const revisions = history.actions as Record<string, unknown>[]
    const revision = revisions[0]!
    const action = catalog.actions.find(entry => entry.handler.kind === 'tool' && entry.handler.tool === 'list_book_actions')!
    await openActions(action.command)
    const currentHistory = record(await call('list_book_actions'))!
    const revisionIndex = (currentHistory.actions as Record<string, unknown>[]).findIndex(entry => entry.hash === revision.hash)
    expect(revisionIndex).toBeGreaterThanOrEqual(0)
    await page.locator('.workspace-action-linked-results > li').nth(revisionIndex).getByRole('button', { name: 'Preview revision', exact: true }).click()
    await page.locator('form[data-action-id="tool.get_history_action"]').waitFor()
    const target = page.getByRole('combobox', { name: 'Action id', exact: true })
    await expect.poll(() => target.inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toBe(String(revision.hash))
    await applySheet('Run action')
    await expect.poll(() => page.getByLabel('Action result', { exact: true }).textContent(), { timeout: MCP_ROUNDTRIP_MS }).toContain(String(revision.operationId))
    expect(browserErrors).toEqual([])
  })

  it('updates advanced fields when switching between saved items', async () => {
    const first = record(await call('create_entity', { kind: 'prompt', name: 'First structured prompt', prompt: 'First prompt', data: { lens: '35mm' } }))!
    const second = record(await call('create_entity', { kind: 'prompt', name: 'Second structured prompt', prompt: 'Second prompt', data: { lens: '85mm' } }))!
    const action = catalog.actions.find(entry => entry.handler.kind === 'tool' && entry.handler.tool === 'update_entity')!
    await openActions(action.command)
    const picker = page.getByLabel('Saved item', { exact: true })
    await picker.selectOption(String(first.id))
    const data = page.getByLabel('Data', { exact: true })
    await expect.poll(() => data.inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toContain('35mm')
    await data.fill('{')
    await page.getByLabel('Prompt', { exact: true }).fill('An unfinished first edit')
    expect(await data.inputValue()).toBe('{')
    expect(await data.evaluate(element => (element as HTMLTextAreaElement).validity.valid)).toBe(false)
    await picker.selectOption(String(second.id))
    await expect.poll(() => data.inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toContain('85mm')
    expect(await data.evaluate(element => (element as HTMLTextAreaElement).validity.valid)).toBe(true)
    await page.getByLabel('Prompt', { exact: true }).fill('Second prompt revised')
    await applySheet('Run action')
    await expect.poll(async () => record(await call('get_entity', { entity_id: second.id }))?.prompt, { timeout: MCP_ROUNDTRIP_MS }).toBe('Second prompt revised')
    expect(record(await call('get_entity', { entity_id: first.id }))?.data).toEqual({ lens: '35mm' })
    expect(record(await call('get_entity', { entity_id: second.id }))?.data).toEqual({ lens: '85mm' })
  })

  it('previews and restores a script revision from its history controls', async () => {
    const firstContent = '# Original scene\n\nThe first version.'
    const nextContent = '# Revised scene\n\nThe second version.'
    const script = record(await call('upload_file', { filename: 'history-draft.md', data: Buffer.from(firstContent).toString('base64') }))!
    const scriptId = String(script.assetId)
    const initialHistory = await call('asset_history', { asset_id: scriptId }) as Record<string, unknown>[]
    const originalHash = String(initialHistory[0]!.hash)
    await call('update_script', { asset_id: scriptId, content: nextContent })
    const history = await call('asset_history', { asset_id: scriptId }) as Record<string, unknown>[]
    const revisionIndex = history.findIndex(revision => revision.hash === originalHash)
    expect(revisionIndex).toBeGreaterThan(0)
    await page.reload()
    await openActions('/asset-history')
    await page.getByRole('combobox', { name: 'Media', exact: true }).selectOption(scriptId)
    await applySheet('Run action')
    await page.locator('.workspace-action-linked-results > li').nth(revisionIndex).getByRole('button', { name: 'Preview revision', exact: true }).click()
    const hashPicker = page.getByRole('combobox', { name: 'Commit hash', exact: true })
    await expect.poll(() => hashPicker.inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toBe(originalHash)
    await page.getByRole('combobox', { name: 'Filename', exact: true }).selectOption('original.md')
    await applySheet('Run action')
    await expect.poll(() => page.getByLabel('Action result', { exact: true }).textContent(), { timeout: MCP_ROUNDTRIP_MS }).toContain(firstContent)
    expect(await (await fetch(`${origin}/files/${bookId}/${scriptId}/original.md`)).text()).toBe(nextContent)
    await page.keyboard.press('Escape')
    await openActions('/asset-history')
    await page.getByRole('combobox', { name: 'Media', exact: true }).selectOption(scriptId)
    await applySheet('Run action')
    await page.locator('.workspace-action-linked-results > li').nth(revisionIndex).getByRole('button', { name: 'Restore revision', exact: true }).click()
    await expect.poll(() => hashPicker.inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toBe(originalHash)
    expect(await (await fetch(`${origin}/files/${bookId}/${scriptId}/original.md`)).text()).toBe(nextContent)
    await applySheet('Run action')
    await expect.poll(async () => (await fetch(`${origin}/files/${bookId}/${scriptId}/original.md`)).text(), { timeout: MCP_ROUNDTRIP_MS }).toBe(firstContent)
    const restoredHistory = await call('asset_history', { asset_id: scriptId }) as Record<string, unknown>[]
    expect(restoredHistory[0]!.hash).not.toBe(originalHash)
    expect(restoredHistory.some(revision => revision.hash === originalHash)).toBe(true)
    expect(browserErrors).toEqual([])
  })

  it('loads a committed edit audit using the edit action identity', async () => {
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: videoId }] })
    await page.reload()
    const sequence = record(await call('get_primary_sequence'))!
    const clip = (sequence.clips as Record<string, unknown>[])[0]!
    await sendCommand(`/clip-reverse @${String(clip.clipId)}`)
    await sendCommand('/apply')
    let actionId = ''
    await expect.poll(async () => {
      const history = record(await call('list_book_actions'))!
      const revision = (history.actions as Record<string, unknown>[]).find(entry => entry.operation === 'commit_edit')
      actionId = String(record(revision?.details)?.actionId ?? '')
      return actionId
    }, { timeout: MCP_ROUNDTRIP_MS }).not.toBe('')
    const action = catalog.actions.find(entry => entry.handler.kind === 'tool' && entry.handler.tool === 'get_edit_action')!
    await openActions(action.command)
    await page.getByRole('combobox', { name: 'Action id', exact: true }).selectOption(actionId)
    await applySheet('Run action')
    await expect.poll(() => page.getByLabel('Action result', { exact: true }).textContent(), { timeout: MCP_ROUNDTRIP_MS }).toContain(actionId)
    expect(record(await call('get_edit_action', { action_id: actionId }))?.actionId).toBe(actionId)
  })

  it('previews a historical file that is absent from the current version', async () => {
    const character = record(await call('create_character', { args: ['Historical notes'] }))!
    const characterId = String(character.asset_id)
    const originalHistory = await call('asset_history', { asset_id: characterId }) as Record<string, unknown>[]
    const content = 'Notes preserved only in the older revision.'
    const upload = await fetch(`${origin}/api/books/${bookId}/upload?${new URLSearchParams({ filename: 'notes.txt', targetAssetId: characterId })}`, { method: 'POST', body: content })
    expect(upload.status).toBe(200)
    const writtenHistory = await call('asset_history', { asset_id: characterId }) as Record<string, unknown>[]
    const writtenHash = String(writtenHistory[0]!.hash)
    await call('restore_asset_version', { asset_id: characterId, commit_hash: originalHistory[0]!.hash })
    expect((await fetch(`${origin}/files/${bookId}/${characterId}/notes.txt`)).status).toBe(404)
    const history = await call('asset_history', { asset_id: characterId }) as Record<string, unknown>[]
    await page.reload()
    await openActions('/asset-history')
    await page.getByRole('combobox', { name: 'Media', exact: true }).selectOption(characterId)
    await applySheet('Run action')
    await page.locator('.workspace-action-linked-results > li').nth(history.findIndex(revision => revision.hash === writtenHash))
      .getByRole('button', { name: 'Preview revision', exact: true }).click()
    await expect.poll(() => page.getByRole('combobox', { name: 'Commit hash', exact: true }).inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toBe(writtenHash)
    await page.getByRole('combobox', { name: 'Filename', exact: true }).selectOption('notes.txt', { timeout: 5000 })
    await applySheet('Run action')
    await expect.poll(() => page.getByLabel('Action result', { exact: true }).textContent(), { timeout: MCP_ROUNDTRIP_MS }).toContain(content)
    expect((await fetch(`${origin}/files/${bookId}/${characterId}/notes.txt`)).status).toBe(404)
    await page.screenshot({ path: '/tmp/videobook-e2e-hour-historical-preview.png' })
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByLabel('Videobook command input', { exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await openActions()
    await page.getByRole('button', { name: 'Close action search', exact: true }).click()
    await expect.poll(() => page.getByLabel('Videobook command input', { exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    expect(browserErrors).toEqual([])
  })

  it('captures a preview target and closes the preview when sending a media action', async () => {
    await openActions('/open')
    await page.getByRole('combobox', { name: 'Media', exact: true }).selectOption(imageId)
    await applySheet('Run action')
    const preview = page.locator('.workspace-preview-dialog')
    await preview.waitFor()
    await expect.poll(() => preview.locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth), { timeout: MCP_ROUNDTRIP_MS }).toBeGreaterThan(0)
    await preview.getByRole('combobox', { name: 'Version or file', exact: true }).selectOption(await originalImageFile())
    await expect.poll(() => preview.locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth), { timeout: MCP_ROUNDTRIP_MS }).toBeGreaterThan(0)
    await preview.getByRole('button', { name: 'More actions', exact: true }).click()
    const action = catalog.actions.find(entry => entry.handler.kind === 'tool' && entry.handler.tool === 'asset_manifest')!
    await page.getByLabel('Videobook command input', { exact: true }).fill(action.command)
    await page.locator(`.workspace-actions-list [data-action-id="${action.id}"]`).click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await preview.waitFor({ state: 'detached' })
    await expect.poll(() => page.getByRole('dialog', { name: 'Workspace action review' }).getByRole('combobox', { name: 'Media', exact: true }).inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toBe(imageId)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('dialog[open]').count()).toBe(0)
    await expect.poll(() => page.getByLabel('Videobook command input', { exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    expect(browserErrors).toEqual([])
  })

  it('keeps chat and Escape usable alongside a review reply', async () => {
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: videoId }] })
    await page.reload()
    const sequence = record(await call('get_primary_sequence'))!
    const clip = (sequence.clips as Record<string, unknown>[])[0]!
    await sendCommand(`/clip-reverse @${String(clip.clipId)}`)
    const sheet = page.getByLabel('Command plan review', { exact: true })
    await sheet.waitFor()
    await page.locator('.chat-turn[data-status="review"] .chat-bubble-assistant').waitFor()
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
    const microphone = page.getByLabel('Start voice conversation', { exact: true })
    expect(await microphone.isDisabled()).toBe(true)
    const stops: Array<{ label: string | null; inComposer: boolean }> = []
    for (let step = 0; step < 4 && stops.at(-1)?.label !== 'Send command'; step += 1) {
      await page.keyboard.press('Tab')
      stops.push(await page.evaluate(() => {
        const active = document.activeElement
        return {
          label: active?.getAttribute('aria-label') ?? null,
          inComposer: Boolean(active?.closest('.command-composer')),
        }
      }))
    }
    expect(stops.at(-1)?.label).toBe('Send command')
    expect(stops.every(stop => stop.inComposer)).toBe(true)
    expect(stops.map(stop => stop.label)).not.toContain('Start voice conversation')
    await page.keyboard.press('Escape')
    await expect.poll(() => sheet.count()).toBe(0)
    expect((record(await call('get_primary_sequence'))?.clips as Record<string, unknown>[])[0]?.reverse).toBe(false)
    await sendCommand(`/clip-reverse @${String(clip.clipId)}`)
    await sheet.waitFor()
    await openActions()
    await page.getByRole('combobox', { name: 'Action category', exact: true }).focus()
    await page.keyboard.press('Escape')
    expect(await sheet.count()).toBe(1)
    await input.focus()
    await input.dispatchEvent('compositionstart')
    await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true })
    expect(await sheet.count()).toBe(1)
    await input.dispatchEvent('compositionend')
    await input.evaluate(element => (element as HTMLElement).blur())
    await page.keyboard.press('Escape')
    await expect.poll(() => sheet.count()).toBe(0)
  })

  it('opens the media picker after repeated navigation with delayed real requests', async () => {
    const cell = record(await call('create_notebook_cell', { notebook_id: notebookId, cell: { type: 'image', slot: { row: 1, column: 1 } } }))!
    await page.route('**/mcp', async route => {
      await new Promise(resolve => setTimeout(resolve, 40))
      await route.continue()
    })
    for (let cycle = 0; cycle < 8; cycle += 1) {
      await page.goto(appUrl, { waitUntil: 'commit' })
      const node = page.locator(`.react-flow__node[data-id="${String(cell.id)}"]`)
      await node.locator('.cell-media-slot-library').click()
      const dialog = page.getByRole('region', { name: 'Choose image media', exact: true })
      await dialog.waitFor()
      await expect.poll(() => dialog.locator('.media-library-asset').count(), { timeout: 15_000 }).toBeGreaterThan(0)
      expect(await dialog.locator('.media-library-asset').filter({ hasText: 'action-image' }).count(), `cycle ${cycle}`).toBe(1)
      await page.keyboard.press('Escape')
      await expect.poll(() => dialog.count()).toBe(0)
      await page.getByLabel('Open Assets', { exact: true }).click()
    }
    expect(browserErrors).toEqual([])
  }, 120_000)

  it('keeps media edits separate from clip edits and exports the reviewed sequence', async () => {
    const timeline = record(await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: videoId }] }))!
    expect(timeline).toBeTruthy()
    await page.reload()
    const sequenceBefore = record(await call('get_primary_sequence'))!
    const clipsBefore = sequenceBefore.clips as Record<string, unknown>[]
    const clipId = String(clipsBefore[0]!.clipId)
    await sendCommand('/export-sequence --captions omit')
    await expect.poll(() => page.getByLabel('Videobook command input', { exact: true }).textContent()).toBe('/apply')
    await sendCommand('/apply')
    await expect.poll(async () => {
      const payload = record(await call('list_assets'))
      return (Array.isArray(payload?.assets) ? payload.assets : []).map(record).filter(entry => entry?.type === 'final' || entry?.kind === 'final').length
    }, { timeout: 30_000 }).toBeGreaterThan(0)
    const original = Buffer.from(await (await fetch(`${origin}/files/${bookId}/${videoId}/original.mp4`)).arrayBuffer())
    await sendCommand('/reverse @a1')
    await expect.poll(async () => {
      const bytes = Buffer.from(await (await fetch(`${origin}/files/${bookId}/${videoId}/original.mp4`)).arrayBuffer())
      return bytes.equals(original)
    }, { timeout: 30_000 }).toBe(false)
    expect(record(await call('get_primary_sequence'))?.clips).toEqual(clipsBefore)
    await sendCommand(`/clip-reverse @${clipId}`)
    await sendCommand('/apply')
    await expect.poll(async () => ((record(await call('get_primary_sequence'))?.clips as Record<string, unknown>[])[0]?.reverse), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
    await sendCommand('/trim @a1 0 1')
    await applySheet('Run action')
    await expect.poll(async () => {
      const payload = record(await call('list_assets'))
      const asset = (Array.isArray(payload?.assets) ? payload.assets : []).map(record).find(entry => entry?.artifact_id === videoId)
      return Number(asset?.duration)
    }, { timeout: 30_000 }).toBeLessThan(1.1)
    await page.keyboard.press('Escape')
    const mediaAfterTrim = Buffer.from(await (await fetch(`${origin}/files/${bookId}/${videoId}/original.mp4`)).arrayBuffer())
    await sendCommand(`/clip-trim @${clipId} 0 15`)
    await sendCommand('/apply')
    await expect.poll(async () => ((record(await call('get_primary_sequence'))?.clips as Record<string, unknown>[])[0]?.durationFrames), { timeout: MCP_ROUNDTRIP_MS }).toBe(15)
    expect(Buffer.from(await (await fetch(`${origin}/files/${bookId}/${videoId}/original.mp4`)).arrayBuffer()).equals(mediaAfterTrim)).toBe(true)
    page.on('dialog', async dialog => { await dialog.accept() })
    await sendCommand(`/clip-delete @${clipId}`)
    await sendCommand('/apply')
    await expect.poll(async () => (record(await call('get_primary_sequence'))?.clips as unknown[]).length, { timeout: MCP_ROUNDTRIP_MS }).toBe(0)
    const duplicate = record(await call('upload_file', { filename: 'delete-me.png', data: (await readFile(join(rootDir, 'image.png'))).toString('base64') }))!
    expect(duplicate.assetId).not.toBe(imageId)
    await page.reload()
    await sendCommand(`/delete ${String(duplicate.assetId)}`)
    await expect.poll(async () => JSON.stringify(await call('list_assets')), { timeout: MCP_ROUNDTRIP_MS }).not.toContain(String(duplicate.assetId))
    expect(JSON.stringify(await call('list_assets'))).toContain(imageId)
  }, 120_000)
})


describe('built-in sound preview and apply without provider credentials', () => {
  it('previews and mixes /sfx @a1 1 zoom-in entirely locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videobook-builtin-sfx-ui-'))
    let localServer: StartedProcess | undefined
    let localVite: StartedProcess | undefined
    let localBrowser: Browser | undefined
    let localClient: Client | undefined
    const exec = promisify(execFile)
    try {
      const port = await availablePort()
      const vitePort = await availablePort()
      const origin = `http://127.0.0.1:${port}`
      const appUrl = `http://127.0.0.1:${vitePort}`
      const env = {
        ...process.env,
        ...Object.fromEntries(Object.keys(process.env).filter(key => key.endsWith('_API_KEY')).map(key => [key, ''])),
        PORT: String(port), OPENAI_API_KEY: '', KIE_API_KEY: '', FAL_API_KEY: '', ELEVENLABS_API_KEY: '',
        KIMI_CODING_API_KEY: '', DASHSCOPE_API_KEY: '', XAI_API_KEY: '',
        VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'runtime/app-state.json'),
      }
      localServer = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
      await waitForHttp(`${origin}/healthz`, localServer, 200)
      const client = new Client({ name: 'builtin-sfx-ui', version: '1.0.0' }, {
        capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
      })
      localClient = client
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
      const book = record(resultValue(await client.callTool({ name: 'create_book', arguments: { name: 'builtin-sfx-ui' } })))!
      const bookId = String(book.bookId)
      const call = async (name: string, args: Record<string, unknown> = {}) => resultValue(await client.callTool({ name, arguments: { book_id: bookId, ...args } }))
      const notebooks = await call('list_notebooks') as Array<{ id: string }>
      const fixture = join(root, 'source.mp4')
      await exec(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=black:size=160x90:rate=24:duration=3',
        '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.05:seed=1:duration=3:sample_rate=48000',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', fixture], { timeout: testBudget(30_000) })
      const upload = record(await call('upload_file', { filename: 'sound-target.mp4', data: (await readFile(fixture)).toString('base64') }))!
      const assetId = String(upload.assetId)
      await call('create_notebook_cell', { notebook_id: notebooks[0]!.id, cell: { type: 'video', slot: { row: 0, column: 0 }, output_artifact_id: assetId } })
      const status = async () => {
        const assets = record(await call('list_assets'))?.assets as Array<{ artifact_id: string; status: string }>
        return assets.find(asset => asset.artifact_id === assetId)?.status
      }
      await expect.poll(status, { timeout: testBudget(60_000) }).toBe('ready')
      localVite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
        ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
      })
      await waitForHttp(appUrl, localVite, 200)
      localBrowser = await chromium.launch({ headless: true })
      const page = await localBrowser.newPage({ viewport: { width: 1440, height: 1000 } })
      page.setDefaultTimeout(testBudget(15_000))
      const remoteRequests: string[] = []
      const errors: string[] = []
      const fontOrigins = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'])
      page.on('request', request => {
        const url = new URL(request.url())
        if (['http:', 'https:'].includes(url.protocol) && ![origin, appUrl].includes(url.origin) && !fontOrigins.has(url.origin)) remoteRequests.push(request.url())
      })
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
      await page.goto(appUrl)
      await expect.poll(() => page.getByLabel('Open actions', { exact: true }).isEnabled(), { timeout: testBudget(15_000) }).toBe(true)
      const input = page.getByLabel('Videobook command input', { exact: true })
      await input.fill('/sfx @a1 1 zoom-in')
      if (await page.locator('.command-suggestions').isVisible()) await input.press('Escape')
      await input.press('Enter')
      const sheet = page.locator('form[data-action-id="tool.apply_builtin_sfx"]')
      await sheet.waitFor()
      const sounds = sheet.getByRole('combobox', { name: /^Sound/u })
      expect(await sounds.inputValue()).toBe('zoom_in')
      expect(await sounds.locator('option:checked').textContent()).toBe('Zoom in')
      expect(await sheet.getByRole('spinbutton', { name: /^Timestamp/u }).inputValue()).toBe('1')
      await sheet.getByRole('button', { name: 'Preview Zoom in', exact: true }).click()
      await expect.poll(() => sheet.getByRole('button', { name: 'Stop Zoom in', exact: true }).count(), { timeout: testBudget(5_000) }).toBe(1)
      await expect.poll(() => sheet.getByRole('button', { name: 'Preview Zoom in', exact: true }).count(), { timeout: testBudget(5_000) }).toBe(1)
      await sounds.selectOption('riser')
      await sheet.getByRole('button', { name: 'Preview Riser', exact: true }).click()
      await sheet.getByRole('button', { name: 'Stop Riser', exact: true }).click()
      expect(await sheet.getByRole('button', { name: 'Preview Riser', exact: true }).count()).toBe(1)
      await sounds.selectOption('zoom_in')
      await page.locator('.command-composer .confirm-sheet-apply').click()
      await expect.poll(() => sheet.locator('.workspace-action-result').textContent(), { timeout: testBudget(60_000) }).toContain('completed')
      await expect.poll(status, { timeout: testBudget(60_000) }).toBe('ready')
      const response = await fetch(`${origin}/files/${bookId}/${assetId}/original.mp4`)
      expect(response.status).toBe(200)
      const mixed = join(root, 'mixed.mp4')
      await writeFile(mixed, Buffer.from(await response.arrayBuffer()))
      const windowRms = async (path: string) => {
        const { stdout } = await exec(FFMPEG, ['-v', 'error', '-ss', '1', '-t', '0.5', '-i', path, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], {
          encoding: 'buffer', maxBuffer: 1_000_000, timeout: testBudget(30_000),
        })
        let sum = 0
        for (let offset = 0; offset < stdout.length; offset += 4) sum += stdout.readFloatLE(offset) ** 2
        return Math.sqrt(sum / (stdout.length / 4))
      }
      expect(20 * Math.log10(await windowRms(mixed) / await windowRms(fixture))).toBeGreaterThanOrEqual(6)
      expect(Math.abs((await probeVideo(mixed)).duration - (await probeVideo(fixture)).duration)).toBeLessThanOrEqual(0.05)
      expect(remoteRequests).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await localBrowser?.close()
      await localClient?.close()
      await stopProcess(localVite)
      await stopProcess(localServer)
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }, testBudget(180_000))
})

describe('local zoom picked on the Actions sheet preview', () => {
  it('previews /zoom @a1 1-2.5 1.5, takes a dragged focus and renders it without a provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videobook-zoom-ui-'))
    let localServer: StartedProcess | undefined
    let localVite: StartedProcess | undefined
    let localBrowser: Browser | undefined
    let localClient: Client | undefined
    const exec = promisify(execFile)
    const width = 324
    const height = 576
    try {
      const port = await availablePort()
      const vitePort = await availablePort()
      const origin = `http://127.0.0.1:${port}`
      const appUrl = `http://127.0.0.1:${vitePort}`
      const env = {
        ...process.env,
        ...Object.fromEntries(Object.keys(process.env).filter(key => key.endsWith('_API_KEY')).map(key => [key, ''])),
        PORT: String(port), OPENAI_API_KEY: '', KIE_API_KEY: '', FAL_API_KEY: '', ELEVENLABS_API_KEY: '',
        KIMI_CODING_API_KEY: '', DASHSCOPE_API_KEY: '', XAI_API_KEY: '',
        VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'runtime/app-state.json'),
      }
      localServer = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
      await waitForHttp(`${origin}/healthz`, localServer, 200)
      const client = new Client({ name: 'zoom-ui', version: '1.0.0' }, {
        capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
      })
      localClient = client
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
      const book = record(resultValue(await client.callTool({ name: 'create_book', arguments: { name: 'zoom-ui' } })))!
      const bookId = String(book.bookId)
      const call = async (name: string, args: Record<string, unknown> = {}) => resultValue(await client.callTool({ name, arguments: { book_id: bookId, ...args } }))
      const notebooks = await call('list_notebooks') as Array<{ id: string }>
      const fixture = join(root, 'source.mp4')
      await exec(FFMPEG, ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30:duration=4`,
        '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.05:seed=1:duration=4:sample_rate=48000',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture], { timeout: testBudget(30_000) })
      const upload = record(await call('upload_file', { filename: 'zoom-target.mp4', data: (await readFile(fixture)).toString('base64') }))!
      const assetId = String(upload.assetId)
      await call('create_notebook_cell', { notebook_id: notebooks[0]!.id, cell: { type: 'video', slot: { row: 0, column: 0 }, output_artifact_id: assetId } })
      const status = async () => {
        const assets = record(await call('list_assets'))?.assets as Array<{ artifact_id: string; status: string }>
        return assets.find(asset => asset.artifact_id === assetId)?.status
      }
      await expect.poll(status, { timeout: testBudget(60_000) }).toBe('ready')
      localVite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
        ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
      })
      await waitForHttp(appUrl, localVite, 200)
      localBrowser = await chromium.launch({ headless: true })
      const page = await localBrowser.newPage({ viewport: { width: 1440, height: 1000 } })
      page.setDefaultTimeout(testBudget(15_000))
      const remoteRequests: string[] = []
      const errors: string[] = []
      const fontOrigins = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'])
      page.on('request', request => {
        const url = new URL(request.url())
        if (['http:', 'https:'].includes(url.protocol) && ![origin, appUrl].includes(url.origin) && !fontOrigins.has(url.origin)) remoteRequests.push(request.url())
      })
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
      await page.goto(appUrl)
      await expect.poll(() => page.getByLabel('Open actions', { exact: true }).isEnabled(), { timeout: testBudget(15_000) }).toBe(true)
      const input = page.getByLabel('Videobook command input', { exact: true })
      await input.fill('/zoom @a1 1-2.5 1.5')
      if (await page.locator('.command-suggestions').isVisible()) await input.press('Escape')
      await input.press('Enter')
      const sheet = page.locator('form[data-action-id="tool.zoom_video"]')
      await sheet.waitFor()
      const preview = sheet.getByRole('region', { name: 'Zoom preview', exact: true })
      const frame = preview.getByRole('group', { name: 'Zoom focus point', exact: true })
      const video = frame.locator('video')
      const marker = frame.locator('.workspace-zoom-focus')
      const field = (name: RegExp) => sheet.getByRole('spinbutton', { name })
      expect(await field(/^Start seconds/u).inputValue()).toBe('1')
      expect(await field(/^End seconds/u).inputValue()).toBe('2.5')
      expect(await field(/^Scale/u).inputValue()).toBe('1.5')
      expect(await marker.evaluate((element: HTMLElement) => [element.style.left, element.style.top])).toEqual(['50%', '50%'])
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: testBudget(15_000) }).toBeGreaterThanOrEqual(1)

      await page.setViewportSize({ width: 390, height: 844 })
      await expect.poll(() => preview.getByRole('button', { name: 'Play zoom', exact: true }).isVisible()).toBe(true)
      const phoneFrame = await frame.boundingBox()
      expect(phoneFrame!.x).toBeGreaterThanOrEqual(0)
      expect(phoneFrame!.x + phoneFrame!.width).toBeLessThanOrEqual(390)
      expect(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: '/tmp/videobook-zoom-phone.png' })
      await page.setViewportSize({ width: 1440, height: 1000 })

      await preview.getByRole('button', { name: 'Play zoom', exact: true }).click()
      const transform = () => video.evaluate((element: HTMLVideoElement) => element.style.transform)
      await expect.poll(transform, { timeout: testBudget(5_000), interval: 50 }).toBe('scale(1.5)')
      await expect.poll(transform, { timeout: testBudget(5_000), interval: 50 }).toBe('scale(1)')

      await frame.scrollIntoViewIfNeeded()
      const box = (await frame.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4, { steps: 8 })
      await page.mouse.up()
      const focusX = Number(await field(/^Focus x/u).inputValue())
      const focusY = Number(await field(/^Focus y/u).inputValue())
      expect(focusX).toBeCloseTo(0.25, 1)
      expect(focusY).toBeCloseTo(0.25, 1)
      expect(Number(await preview.getByRole('slider', { name: 'Horizontal zoom focus', exact: true }).inputValue())).toBeCloseTo(focusX, 2)
      await expect.poll(async () => {
        const [originX, originY] = (await video.evaluate((element: HTMLVideoElement) => element.style.transformOrigin)).split(' ').map(parseFloat)
        return Math.abs(originX! - focusX * 100) < 0.1 && Math.abs(originY! - focusY * 100) < 0.1
      }).toBe(true)
      await page.screenshot({ path: '/tmp/videobook-zoom-desktop.png' })

      await page.locator('.command-composer .confirm-sheet-apply').click()
      await expect.poll(() => sheet.locator('.workspace-action-result').textContent(), { timeout: testBudget(120_000) }).toContain('completed')
      await expect.poll(status, { timeout: testBudget(60_000) }).toBe('ready')
      const response = await fetch(`${origin}/files/${bookId}/${assetId}/original.mp4`)
      expect(response.status).toBe(200)
      const zoomed = join(root, 'zoomed.mp4')
      await writeFile(zoomed, Buffer.from(await response.arrayBuffer()))
      const scale = 1.5
      const crop = `crop=${Math.round(width / scale)}:${Math.round(height / scale)}:${Math.round(focusX * width * (1 - 1 / scale))}:${Math.round(focusY * height * (1 - 1 / scale))},scale=${width}:${height}:flags=bicubic`
      const ssim = async (frameIndex: number, reference: string) => {
        const pick = `select='eq(n,${frameIndex})',format=gray,setpts=PTS-STARTPTS`
        const { stdout } = await exec(FFMPEG, ['-hide_banner', '-v', 'error', '-i', zoomed, '-i', fixture,
          '-filter_complex', `[0:v]${pick}[rendered];[1:v]${pick}${reference}[reference];[rendered][reference]ssim=stats_file=-`,
          '-f', 'null', '-'], { timeout: testBudget(30_000) })
        return Number(/All:([\d.]+)/u.exec(stdout)?.[1])
      }
      expect(await ssim(52, `,${crop}`)).toBeGreaterThanOrEqual(0.95)
      expect(await ssim(15, '')).toBeGreaterThanOrEqual(0.97)
      expect(remoteRequests).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await localBrowser?.close()
      await localClient?.close()
      await stopProcess(localVite)
      await stopProcess(localServer)
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }, testBudget(240_000))
})
