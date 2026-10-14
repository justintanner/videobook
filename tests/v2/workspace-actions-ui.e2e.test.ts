import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { availablePort, record, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'
import type { WorkspaceActionCatalog } from '../../server/src/workspace-action-contract.js'
import { FFMPEG } from '../../server/src/ffmpeg.js'

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

  async function openActions(command?: string): Promise<void> {
    const libraryActions = page.getByLabel('Open library actions', { exact: true })
    if (await libraryActions.isVisible()) await libraryActions.click()
    else await page.getByRole('button', { name: 'Open actions', exact: true }).click()
    await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(100)
    if (!command) return
    await page.getByLabel('Videobook command input', { exact: true }).fill(command)
    await page.locator(`[data-command="${command}"]`).click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await page.getByRole('heading', { level: 3 }).waitFor()
  }

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-workspace-actions-'))
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    origin = `http://127.0.0.1:${mcpPort}`
    appUrl = `http://127.0.0.1:${vitePort}`
    const env = {
      ...process.env, PORT: String(mcpPort), OPENAI_API_KEY: '', KIE_API_KEY: '', FAL_API_KEY: '',
      KIMI_CODING_API_KEY: '', DASHSCOPE_API_KEY: '', ELEVENLABS_API_KEY: '', GOOGLE_FLOW_API_KEY: '',
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
    catalog = await call('list_workspace_actions') as WorkspaceActionCatalog
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
    await page.goto(appUrl)
    await expect.poll(() => page.getByLabel('Open actions', { exact: true }).isEnabled(), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
  })

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
    await search.fill('/even-split')
    expect(await options.count()).toBe(1)
    expect(await options.first().getAttribute('data-command')).toBe('/split-chunks')
    await search.fill('/status')
    expect(await page.locator('[data-command="/activity"]').count()).toBe(1)
  })

  it('runs an actual read and creates a reusable prompt through typed fields', async () => {
    await openActions('/get-book')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(() => page.getByLabel('Action result', { exact: true }).textContent(), { timeout: MCP_ROUNDTRIP_MS }).toContain('action-ui-project')
    await page.getByRole('button', { name: 'All actions', exact: true }).click()
    const createPrompt = catalog.actions.find(action => action.handler.kind === 'tool' && action.handler.tool === 'create_prompt_entity')!
    await page.getByLabel('Videobook command input', { exact: true }).fill(createPrompt.command)
    await page.locator(`[data-action-id="${createPrompt.id}"]`).click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await page.getByLabel('Name', { exact: false }).fill('A reusable shot')
    await page.getByLabel('Prompt', { exact: true }).fill('A slow pan across a quiet lake')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => JSON.stringify(await call('list_prompts')), { timeout: MCP_ROUNDTRIP_MS }).toContain('A slow pan across a quiet lake')
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
      await page.locator(`form.workspace-action-form[data-action-id="${action.id}"]`).waitFor()
      expect(await page.getByRole('button', { name: /^(?:Run action|Review action)$/u }).count(), action.id).toBe(1)
      await page.getByRole('button', { name: 'All actions', exact: true }).click()
    }
    expect(browserErrors).toEqual([])
  }, 300_000)

  it('opens from Library at phone widths and keeps shared action search inside the viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByLabel('Open Library', { exact: true }).click()
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
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Open library actions')
  })

  it('traverses the entire slash list and invokes exact aliases and sequence commands', async () => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await input.fill('/')
    await expect.poll(() => page.locator('.command-suggestions [role="option"]').count()).toBeGreaterThan(300)
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
    await input.fill('/even-split')
    expect(await page.locator('.command-suggestions strong').allTextContents()).toContain('/split-chunks')
    await input.fill('/status')
    expect(await page.locator('.command-suggestions strong').allTextContents()).toContain('/activity')
    await input.press('Enter')
    await page.getByRole('heading', { level: 3, name: 'List book actions' }).waitFor()
    await page.keyboard.press('Escape')
    await input.fill('/insert')
    await input.press('Enter')
    await page.getByRole('heading', { level: 3, name: 'Insert', exact: true }).waitFor()
    expect(await page.getByLabel('Start frame', { exact: false }).getAttribute('type')).toBe('number')
    await page.keyboard.press('Escape')
    await sendCommand('/track-add audio Action soundtrack')
    await expect.poll(async () => JSON.stringify(await call('get_primary_sequence')), { timeout: MCP_ROUNDTRIP_MS }).toContain('Action soundtrack')
  })

  it('opens edit forms from slash, cell menus and Library with the same media target', async () => {
    await sendCommand('/crop @a2')
    await page.getByRole('heading', { level: 3, name: 'Crop image', exact: true }).waitFor()
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).getByRole('combobox', { name: /^Media/u }).inputValue()).toBe(imageId)
    await page.keyboard.press('Escape')
    await page.getByLabel('Open @a2 cell menu', { exact: true }).click()
    const menu = page.getByRole('menu')
    const labels = (await menu.getByRole('menuitem').allTextContents())
      .map((label) => label.replace('⌫', '').trim())
    expect(labels.at(-1)).toContain('Delete')
    expect(labels).not.toContain('More actions')
    await page.keyboard.press('Escape')
    await page.getByLabel('Open Library', { exact: true }).click()
    const imageCard = page.locator('.library-asset-card').filter({ hasText: 'action-image' }).first()
    await imageCard.getByRole('button', { name: /^More actions for/u }).click()
    await page.getByRole('menuitem', { name: 'All media actions', exact: true }).click()
    await page.getByLabel('Videobook command input', { exact: true }).fill('/rename')
    await page.locator('[data-action-id="tool.rename_asset"]').click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).getByRole('combobox', { name: /^Media/u }).inputValue()).toBe(imageId)
  })

  it('edits and deletes a saved prompt using its name while preserving its identity', async () => {
    const entity = record(await call('create_prompt_entity', { name: 'Editable prompt', prompt: 'Before edit', description: 'Keep this description' }))!
    await openActions('/update-prompt-entity')
    await page.getByLabel('Saved item', { exact: true }).selectOption(String(entity.id))
    await page.getByLabel('Prompt', { exact: true }).fill('After edit')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => record(await call('get_prompt_entity', { entity_id: entity.id }))?.prompt, { timeout: MCP_ROUNDTRIP_MS }).toBe('After edit')
    expect(record(await call('get_prompt_entity', { entity_id: entity.id }))?.description).toBe('Keep this description')
    await page.keyboard.press('Escape')
    await openActions('/delete-prompt-entity')
    await page.getByRole('combobox', { name: /^Entity\b/u }).selectOption(String(entity.id))
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    expect(JSON.stringify(await call('list_prompts'))).toContain('Editable prompt')
    await page.getByRole('button', { name: 'Confirm and run', exact: true }).click()
    await expect.poll(async () => JSON.stringify(await call('list_prompts')), { timeout: MCP_ROUNDTRIP_MS }).not.toContain('Editable prompt')
  })

  it('exports an asset to isolated Downloads without entering the sequence export flow', async () => {
    await sendCommand('/export @a2')
    await expect.poll(async () => (await readdir(join(rootDir, 'downloads'))).length, { timeout: MCP_ROUNDTRIP_MS }).toBe(1)
    const [filename] = await readdir(join(rootDir, 'downloads'))
    const exported = await readFile(join(rootDir, 'downloads', filename!))
    const original = await originalImageBytes()
    expect(exported.equals(original)).toBe(true)
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).count()).toBe(0)
  })

  it('switches an advanced provider while retaining the draft and reviews unknown cost without generating', async () => {
    const original = catalog.actions.find(action => action.id === 'tool.generate_kie_qwen_3_0_edit_image')!
    await openActions(original.command)
    await page.getByRole('textbox', { name: /^Prompt\b/u }).fill('Keep the same scene and use a watercolor style')
    await page.getByText('Advanced provider and model', { exact: true }).click()
    await page.getByLabel('Provider and model', { exact: true }).selectOption('tool.generate_fal_qwen_3_0_edit_image')
    await page.getByRole('heading', { level: 3, name: 'Generate fal qwen 3 0 edit image' }).waitFor()
    expect(await page.getByRole('textbox', { name: /^Prompt\b/u }).inputValue()).toBe('Keep the same scene and use a watercolor style')
    const refs = page.getByRole('dialog', { name: 'Workspace actions' }).locator('select').filter({ has: page.locator(`option[value="${imageId}"]`) })
    await refs.first().selectOption(imageId)
    const before = JSON.stringify(await call('list_jobs'))
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    await page.getByText('Cost estimate unavailable', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Confirm and run', exact: true }).isEnabled()).toBe(true)
    expect(JSON.stringify(await call('list_jobs'))).toBe(before)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '/tmp/videobook-actions-provider-review.png' })
  })

  it('crops an image through visible controls and persists a square result', async () => {
    const original = await originalImageBytes()
    await sendCommand('/crop @a2')
    await page.getByRole('button', { name: 'Square 1:1', exact: true }).click()
    expect(await page.getByRole('spinbutton', { name: /^W\b/u }).inputValue()).toBe('0.75')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
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
    await page.getByLabel('Selection actions', { exact: true }).click()
    const run = catalog.actions.find(action => action.id === 'tool.run_notebook')!
    await page.getByLabel('Videobook command input', { exact: true }).fill(run.command)
    await page.locator('.workspace-actions-list [data-action-id="tool.run_notebook"]').click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    const targets = page.getByRole('group', { name: 'Cell ids', exact: true }).locator('select')
    await expect.poll(() => targets.count(), { timeout: MCP_ROUNDTRIP_MS }).toBe(2)
    const selected = await targets.evaluateAll(elements => elements.map(element => (element as HTMLSelectElement).value))
    expect(selected.sort()).toEqual(selectedIds.sort())
    await page.keyboard.press('Escape')
    await page.getByLabel('Open @a1 cell menu', { exact: true }).click()
    await page.getByRole('menuitem', { name: 'Open media', exact: true }).click()
    const fullscreen = page.getByRole('dialog', { name: 'Fullscreen preview for @a1', exact: true })
    await fullscreen.waitFor()
    expect(await fullscreen.locator('.command-composer').count()).toBe(0)
    await page.keyboard.press('Control+Shift+K')
    await page.getByLabel('Videobook command input', { exact: true }).fill('/asset-manifest')
    await page.locator('.workspace-actions-list [data-action-id="tool.asset_manifest"]').click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).getByRole('combobox', { name: 'Media', exact: true }).inputValue()).toBe(videoId)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })

  it('creates, opens, renames and deletes a notebook through the action controls', async () => {
    await page.keyboard.press('Control+Shift+K')
    await page.getByLabel('Videobook command input', { exact: true }).fill('/create-notebook')
    await page.locator('.workspace-actions-list [data-action-id="tool.create_notebook"]').click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('A managed notebook')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => JSON.stringify(await call('list_notebooks')), { timeout: MCP_ROUNDTRIP_MS }).toContain('A managed notebook')
    const created = (await call('list_notebooks') as Record<string, unknown>[]).find(entry => entry.name === 'A managed notebook')!
    await page.keyboard.press('Escape')
    await openActions(catalog.actions.find(action => action.id === 'tool.list_notebooks')!.command)
    await page.locator('.workspace-action-linked-results li').filter({ hasText: 'A managed notebook' }).getByRole('button', { name: 'Open notebook', exact: true }).click()
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await page.getByRole('dialog', { name: 'Workspace actions' }).waitFor({ state: 'hidden' })
    expect(await page.evaluate(id => localStorage.getItem(`videobook.active-notebook:${id}`), bookId)).toBe(created.id)
    await openActions('/rename-notebook')
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Managed notebook renamed')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => JSON.stringify(await call('list_notebooks')), { timeout: MCP_ROUNDTRIP_MS }).toContain('Managed notebook renamed')
    await page.keyboard.press('Escape')
    await openActions('/delete-notebook')
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel review', exact: true }).click()
    expect(JSON.stringify(await call('list_notebooks'))).toContain(String(created.id))
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm and run', exact: true }).click()
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
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(() => page.getByLabel('Action result', { exact: true }).textContent(), { timeout: MCP_ROUNDTRIP_MS }).toContain(String(revision.operationId))
    expect(browserErrors).toEqual([])
  })

  it('updates advanced fields when switching between saved items', async () => {
    const first = record(await call('create_prompt_entity', { name: 'First structured prompt', prompt: 'First prompt', data: { lens: '35mm' } }))!
    const second = record(await call('create_prompt_entity', { name: 'Second structured prompt', prompt: 'Second prompt', data: { lens: '85mm' } }))!
    const action = catalog.actions.find(entry => entry.handler.kind === 'tool' && entry.handler.tool === 'update_prompt_entity')!
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
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => record(await call('get_prompt_entity', { entity_id: second.id }))?.prompt, { timeout: MCP_ROUNDTRIP_MS }).toBe('Second prompt revised')
    expect(record(await call('get_prompt_entity', { entity_id: first.id }))?.data).toEqual({ lens: '35mm' })
    expect(record(await call('get_prompt_entity', { entity_id: second.id }))?.data).toEqual({ lens: '85mm' })
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
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await page.locator('.workspace-action-linked-results > li').nth(revisionIndex).getByRole('button', { name: 'Preview revision', exact: true }).click()
    const hashPicker = page.getByRole('combobox', { name: 'Commit hash', exact: true })
    await expect.poll(() => hashPicker.inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toBe(originalHash)
    await page.getByRole('combobox', { name: 'Filename', exact: true }).selectOption('original.md')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(() => page.getByLabel('Action result', { exact: true }).textContent(), { timeout: MCP_ROUNDTRIP_MS }).toContain(firstContent)
    expect(await (await fetch(`${origin}/files/${bookId}/${scriptId}/original.md`)).text()).toBe(nextContent)
    await page.keyboard.press('Escape')
    await openActions('/asset-history')
    await page.getByRole('combobox', { name: 'Media', exact: true }).selectOption(scriptId)
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await page.locator('.workspace-action-linked-results > li').nth(revisionIndex).getByRole('button', { name: 'Restore revision', exact: true }).click()
    await expect.poll(() => hashPicker.inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toBe(originalHash)
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    expect(await (await fetch(`${origin}/files/${bookId}/${scriptId}/original.md`)).text()).toBe(nextContent)
    await page.getByRole('button', { name: 'Confirm and run', exact: true }).click()
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
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
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
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await page.locator('.workspace-action-linked-results > li').nth(history.findIndex(revision => revision.hash === writtenHash))
      .getByRole('button', { name: 'Preview revision', exact: true }).click()
    await expect.poll(() => page.getByRole('combobox', { name: 'Commit hash', exact: true }).inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toBe(writtenHash)
    await page.getByRole('combobox', { name: 'Filename', exact: true }).selectOption('notes.txt', { timeout: 5000 })
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
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
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
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
    await expect.poll(() => page.getByRole('dialog', { name: 'Workspace actions' }).getByRole('combobox', { name: 'Media', exact: true }).inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toBe(imageId)
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
    // Out of the input, Tab walks the composer's own row to the send control.
    // The microphone stays unavailable while the review owns the composer, so
    // Tab steps from the lit mode cell straight to send.
    expect(await page.getByLabel('Start voice conversation', { exact: true }).isDisabled()).toBe(true)
    for (const label of ['Chat model', 'Send command']) {
      await page.keyboard.press('Tab')
      await expect.poll(() => page.getByLabel(label, { exact: true })
        .evaluate(element => element === document.activeElement), { timeout: 5_000 })
        .toBe(true)
    }
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
      await page.getByLabel('Open Library', { exact: true }).click()
    }
    expect(browserErrors).toEqual([])
  }, 120_000)

  it('keeps library actions scoped to the owning project when labels match', async () => {
    const foreignBook = record(await call('create_book', { name: 'foreign-action-project' }))!
    const foreignBookId = String(foreignBook.bookId)
    const foreign = record(await call('upload_file', { book_id: foreignBookId, filename: 'foreign.png', data: (await readFile(join(rootDir, 'image.png'))).toString('base64') }))!
    const foreignId = String(foreign.assetId)
    await call('rename_asset', { asset_id: imageId, new_name: 'Matching media label' })
    await call('rename_asset', { book_id: foreignBookId, asset_id: foreignId, new_name: 'Matching media label' })
    await page.getByLabel('Open Library', { exact: true }).click()
    await page.getByRole('button', { name: 'All books', exact: true }).click()
    const foreignCard = page.locator('.library-asset-card').filter({ hasText: 'foreign-action-project' })
    await foreignCard.getByRole('button', { name: 'More actions for Matching media label', exact: true }).click()
    await page.getByRole('menuitem', { name: 'All media actions', exact: true }).click()
    await page.getByLabel('Videobook command input', { exact: true }).fill('/rename')
    await page.locator('[data-action-id="tool.rename_asset"]').click()
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await expect.poll(() => page.getByRole('combobox', { name: 'Media', exact: true }).inputValue()).toBe(foreignId)
    await page.getByRole('textbox', { name: 'New name', exact: true }).fill('Foreign media renamed')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => {
      const value = record(await call('list_assets', { book_id: foreignBookId }))!
      return (value.assets as Record<string, unknown>[]).find(asset => asset.artifact_id === foreignId)?.label
    }, { timeout: MCP_ROUNDTRIP_MS }).toBe('Foreign media renamed')
    const original = record(await call('list_assets'))!
    expect((original.assets as Record<string, unknown>[]).find(asset => asset.artifact_id === imageId)?.label).toBe('Matching media label')
    expect(browserErrors).toEqual([])
  })

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
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm and run', exact: true }).click()
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
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm and run', exact: true }).click()
    await expect.poll(async () => JSON.stringify(await call('list_assets')), { timeout: MCP_ROUNDTRIP_MS }).not.toContain(String(duplicate.assetId))
    expect(JSON.stringify(await call('list_assets'))).toContain(imageId)
  }, 120_000)
})
