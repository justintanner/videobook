import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { availablePort, record, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'
import type { WorkspaceActionCatalog } from '../../server/src/workspace-action-contract.js'
import { FFMPEG } from '../../server/src/ffmpeg.js'

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
    await expect.poll(() => input.isEnabled()).toBe(true)
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return resultValue(await client.callTool({ name, arguments: { book_id: bookId, ...args } }))
  }

  async function openActions(command?: string): Promise<void> {
    await page.getByLabel('Open actions', { exact: true }).click()
    await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(100)
    if (!command) return
    await page.getByLabel('Search actions', { exact: true }).fill(command)
    await page.locator(`[data-command="${command}"]`).click()
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
      if (!['plan_sequence_export', 'enqueue_sequence_export', 'preview_edit_intent', 'apply_command_plan'].includes(String(params?.name))) return
      commandResponses.push({ request: payload, response: await response.text().catch(() => 'unavailable') })
    })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
    await expect.poll(() => page.getByLabel('Open actions', { exact: true }).isEnabled()).toBe(true)
  })

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      const evidencePath = `/tmp/videobook-actions-${task.name.replace(/[^a-z0-9]+/giu, '-').slice(0, 90)}`
      await page.screenshot({ path: `${evidencePath}.png` })
      await writeFile(`${evidencePath}.txt`, await page.locator('body').innerText())
      await writeFile(`${evidencePath}.json`, JSON.stringify({ browserErrors, commandResponses, navigations }, null, 2))
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
    const search = page.getByLabel('Search actions', { exact: true })
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
    await expect.poll(() => page.getByLabel('Action result', { exact: true }).textContent()).toContain('action-ui-project')
    await page.getByRole('button', { name: 'All actions', exact: true }).click()
    const createPrompt = catalog.actions.find(action => action.handler.kind === 'tool' && action.handler.tool === 'create_prompt_entity')!
    await page.getByLabel('Search actions', { exact: true }).fill(createPrompt.command)
    await page.locator(`[data-action-id="${createPrompt.id}"]`).click()
    await page.getByLabel('Name', { exact: false }).fill('A reusable shot')
    await page.getByLabel('Prompt', { exact: true }).fill('A slow pan across a quiet lake')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => JSON.stringify(await call('list_prompts'))).toContain('A slow pan across a quiet lake')
    await page.getByLabel('Action result', { exact: true }).waitFor()
    await page.screenshot({ path: '/tmp/videobook-actions-prompt.png' })
  })

  it('opens a typed form for every catalog action without starting mutations', async () => {
    await openActions()
    for (const action of catalog.actions) {
      const search = page.getByLabel('Search actions', { exact: true })
      await search.fill(action.command)
      await page.locator(`.workspace-actions-list [data-action-id="${action.id}"]`).click()
      await page.locator(`form.workspace-action-form[data-action-id="${action.id}"]`).waitFor()
      expect(await page.getByRole('button', { name: /^(?:Run action|Review action)$/u }).count(), action.id).toBe(1)
      await page.getByRole('button', { name: 'All actions', exact: true }).click()
    }
    expect(browserErrors).toEqual([])
  }, 300_000)

  it('opens from Library at phone widths and keeps the dialog inside the viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByLabel('Open Library', { exact: true }).click()
    await openActions()
    const dialog = page.getByRole('dialog', { name: 'Workspace actions' })
    expect(await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
    })).toBe(true)
    await page.getByLabel('Search actions', { exact: true }).fill('generate fal')
    await page.screenshot({ path: '/tmp/videobook-actions-mobile.png' })
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.setViewportSize({ width: 320, height: 844 })
    expect(await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth
    })).toBe(true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => page.getByLabel('Open actions', { exact: true }).evaluate(element => document.activeElement === element)).toBe(true)
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
    await expect.poll(async () => JSON.stringify(await call('get_primary_sequence'))).toContain('Action soundtrack')
  })

  it('opens edit forms from slash, cell menus, the inspector and Library with the same media target', async () => {
    await sendCommand('/crop @a2')
    await page.getByRole('heading', { level: 3, name: 'Crop image', exact: true }).waitFor()
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).getByRole('combobox', { name: /^Media/u }).inputValue()).toBe(imageId)
    await page.keyboard.press('Escape')
    await page.getByLabel('Open @a2 cell menu', { exact: true }).click()
    const menu = page.getByRole('menu')
    expect((await menu.getByRole('menuitem').allTextContents()).at(-1)).toContain('Delete')
    await menu.getByRole('menuitem', { name: 'More actions', exact: true }).click()
    await page.getByLabel('Search actions', { exact: true }).fill('/crop-image')
    await page.locator('[data-action-id="tool.crop_image"]').click()
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).getByRole('combobox', { name: /^Media/u }).inputValue()).toBe(imageId)
    await page.keyboard.press('Escape')
    await page.getByLabel('Open @a2 cell menu', { exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit cell', exact: true }).click()
    await page.getByLabel('Inspector actions', { exact: true }).click()
    await page.getByLabel('Search actions', { exact: true }).fill('/asset-manifest')
    await page.locator('[data-action-id="tool.asset_manifest"]').click()
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).getByRole('combobox', { name: /^Media/u }).inputValue()).toBe(imageId)
    await page.keyboard.press('Escape')
    await page.getByLabel('Open Library', { exact: true }).click()
    const imageCard = page.locator('.library-asset-card').filter({ hasText: 'action-image' }).first()
    await imageCard.getByRole('button', { name: /^More actions for/u }).click()
    await page.getByRole('menuitem', { name: 'All media actions', exact: true }).click()
    await page.getByLabel('Search actions', { exact: true }).fill('/rename')
    await page.locator('[data-action-id="tool.rename_asset"]').click()
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).getByRole('combobox', { name: /^Media/u }).inputValue()).toBe(imageId)
  })

  it('edits and deletes a saved prompt using its name while preserving its identity', async () => {
    const entity = record(await call('create_prompt_entity', { name: 'Editable prompt', prompt: 'Before edit', description: 'Keep this description' }))!
    await openActions('/update-prompt-entity')
    await page.getByLabel('Saved item', { exact: true }).selectOption(String(entity.id))
    await page.getByLabel('Prompt', { exact: true }).fill('After edit')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => record(await call('get_prompt_entity', { entity_id: entity.id }))?.prompt).toBe('After edit')
    expect(record(await call('get_prompt_entity', { entity_id: entity.id }))?.description).toBe('Keep this description')
    await page.keyboard.press('Escape')
    await openActions('/delete-prompt-entity')
    await page.getByLabel('Entity', { exact: false }).selectOption(String(entity.id))
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    expect(JSON.stringify(await call('list_prompts'))).toContain('Editable prompt')
    await page.getByRole('button', { name: 'Confirm and run', exact: true }).click()
    await expect.poll(async () => JSON.stringify(await call('list_prompts'))).not.toContain('Editable prompt')
  })

  it('exports an asset to isolated Downloads without entering the sequence export flow', async () => {
    await sendCommand('/export @a2')
    await expect.poll(async () => (await readdir(join(rootDir, 'downloads'))).length).toBe(1)
    const [filename] = await readdir(join(rootDir, 'downloads'))
    const exported = await readFile(join(rootDir, 'downloads', filename!))
    const original = Buffer.from(await (await fetch(`${origin}/files/${bookId}/${imageId}/original.png`)).arrayBuffer())
    expect(exported.equals(original)).toBe(true)
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).count()).toBe(0)
  })

  it('switches an advanced provider while retaining the draft and reviews unknown cost without generating', async () => {
    const original = catalog.actions.find(action => action.id === 'tool.generate_kie_qwen_3_0_edit_image')!
    await openActions(original.command)
    await page.getByLabel('Prompt', { exact: false }).first().fill('Keep the same scene and use a watercolor style')
    await page.getByText('Advanced provider and model', { exact: true }).click()
    await page.getByLabel('Provider and model', { exact: true }).selectOption('tool.generate_fal_qwen_3_0_edit_image')
    await page.getByRole('heading', { level: 3, name: 'Generate fal qwen 3 0 edit image' }).waitFor()
    expect(await page.getByLabel('Prompt', { exact: false }).first().inputValue()).toBe('Keep the same scene and use a watercolor style')
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
    const original = Buffer.from(await (await fetch(`${origin}/files/${bookId}/${imageId}/original.png`)).arrayBuffer())
    await sendCommand('/crop @a2')
    await page.getByRole('button', { name: 'Square 1:1', exact: true }).click()
    expect(await page.getByRole('spinbutton', { name: /^W\b/u }).inputValue()).toBe('0.75')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => {
      const payload = record(await call('list_assets'))
      const asset = (Array.isArray(payload?.assets) ? payload.assets : []).map(record).find(entry => entry?.artifact_id === imageId)
      return [asset?.width, asset?.height]
    }, { timeout: 30_000 }).toEqual([1080, 1080])
    const cropped = Buffer.from(await (await fetch(`${origin}/files/${bookId}/${imageId}/original.png`)).arrayBuffer())
    expect(cropped.equals(original)).toBe(false)
    await page.screenshot({ path: '/tmp/videobook-actions-crop-result.png' })
  })

  it('preserves empty-slot, multiple-selection and fullscreen targets through their action controls', async () => {
    const square = await page.locator('.notebook-grid-square').filter({ has: page.locator('.notebook-grid-square-label', { hasText: /^@a3$/u }) }).boundingBox()
    if (!square) throw new Error('The empty @a3 slot is missing')
    await page.mouse.click(square.x + square.width / 2, square.y + square.height / 2, { button: 'right' })
    await page.getByRole('menuitem', { name: 'More actions', exact: true }).click()
    await page.getByLabel('Search actions', { exact: true }).fill('/create-notebook-cell')
    await page.locator('.workspace-actions-list [data-action-id="tool.create_notebook_cell"]').click()
    expect(await page.getByRole('spinbutton', { name: 'Row', exact: true }).inputValue()).toBe('0')
    expect(await page.getByRole('spinbutton', { name: 'Column', exact: true }).inputValue()).toBe('2')
    await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption({ label: 'image' })
    await page.getByRole('combobox', { name: 'Output media', exact: true }).selectOption(imageId)
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => {
      const document = record(await call('get_notebook', { notebook_id: notebookId }))
      return (document?.cells as Record<string, unknown>[]).some(cell => record(cell.slot)?.row === 0 && record(cell.slot)?.column === 2 && cell.output_artifact_id === imageId)
    }).toBe(true)
    await page.keyboard.press('Escape')
    const document = record(await call('get_notebook', { notebook_id: notebookId }))!
    const cells = document.cells as Record<string, unknown>[]
    const selectedIds = cells.filter(cell => record(cell.slot)?.row === 0 && Number(record(cell.slot)?.column) < 2).map(cell => String(cell.id))
    await page.locator(`[data-id="${selectedIds[0]}"] .cell-node-footer strong`).click()
    await page.locator(`[data-id="${selectedIds[1]}"] .cell-node-footer strong`).click({ modifiers: ['Shift'] })
    await page.getByLabel('Selection actions', { exact: true }).click()
    const run = catalog.actions.find(action => action.id === 'tool.run_notebook')!
    await page.getByLabel('Search actions', { exact: true }).fill(run.command)
    await page.locator('.workspace-actions-list [data-action-id="tool.run_notebook"]').click()
    const targets = page.getByRole('group', { name: 'Cell ids', exact: true }).locator('select')
    await expect.poll(() => targets.count()).toBe(2)
    const selected = await targets.evaluateAll(elements => elements.map(element => (element as HTMLSelectElement).value))
    expect(selected.sort()).toEqual(selectedIds.sort())
    await page.keyboard.press('Escape')
    await page.getByLabel('Open @a1 cell menu', { exact: true }).click()
    await page.getByRole('menuitem', { name: 'Open media', exact: true }).click()
    await page.getByLabel('More media actions', { exact: true }).click()
    await page.getByLabel('Search actions', { exact: true }).fill('/asset-manifest')
    await page.locator('.workspace-actions-list [data-action-id="tool.asset_manifest"]').click()
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).getByRole('combobox', { name: 'Media', exact: true }).inputValue()).toBe(videoId)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const created = cells.find(cell => record(cell.slot)?.row === 0 && record(cell.slot)?.column === 2)!
    await call('delete_notebook_cell', { notebook_id: notebookId, cell_id: created.id })
  })

  it('creates, opens, renames and deletes a notebook through the action controls', async () => {
    await page.keyboard.press('Control+Shift+K')
    await page.getByLabel('Search actions', { exact: true }).fill('/create-notebook')
    await page.locator('.workspace-actions-list [data-action-id="tool.create_notebook"]').click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('A managed notebook')
    await page.getByRole('button', { name: 'Run action', exact: true }).click()
    await expect.poll(async () => JSON.stringify(await call('list_notebooks'))).toContain('A managed notebook')
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
    await expect.poll(async () => JSON.stringify(await call('list_notebooks'))).toContain('Managed notebook renamed')
    await page.keyboard.press('Escape')
    await openActions('/delete-notebook')
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel review', exact: true }).click()
    expect(JSON.stringify(await call('list_notebooks'))).toContain(String(created.id))
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm and run', exact: true }).click()
    await expect.poll(async () => JSON.stringify(await call('list_notebooks'))).not.toContain(String(created.id))
    expect(await page.getByRole('alert').count()).toBe(0)
  })

  it('rejects an export when the cut changes after its review', async () => {
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: videoId }] })
    await page.reload()
    await sendCommand('/export-sequence --captions omit')
    await expect.poll(() => page.getByLabel('Videobook command input', { exact: true }).inputValue()).toBe('/apply')
    await call('add_sequence_track', { kind: 'audio', name: 'Changed after review' })
    await sendCommand('/apply')
    await page.getByText(/The sequence changed after review\. Review the current cut before exporting\./u).first().waitFor()
    expect(commandResponses.some(entry => record(record(record(entry)?.request)?.params)?.name === 'enqueue_sequence_export')).toBe(false)
    await sendCommand('/cancel')
  })

  it('keeps media edits separate from clip edits and exports the reviewed sequence', async () => {
    const timeline = record(await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: videoId }] }))!
    expect(timeline).toBeTruthy()
    await page.reload()
    const sequenceBefore = record(await call('get_primary_sequence'))!
    const clipsBefore = sequenceBefore.clips as Record<string, unknown>[]
    const clipId = String(clipsBefore[0]!.clipId)
    await sendCommand('/export-sequence --captions omit')
    await expect.poll(() => page.getByLabel('Videobook command input', { exact: true }).inputValue()).toBe('/apply')
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
    await expect.poll(async () => ((record(await call('get_primary_sequence'))?.clips as Record<string, unknown>[])[0]?.reverse)).toBe(true)
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
    await expect.poll(async () => ((record(await call('get_primary_sequence'))?.clips as Record<string, unknown>[])[0]?.durationFrames)).toBe(15)
    expect(Buffer.from(await (await fetch(`${origin}/files/${bookId}/${videoId}/original.mp4`)).arrayBuffer()).equals(mediaAfterTrim)).toBe(true)
    page.on('dialog', async dialog => { await dialog.accept() })
    await sendCommand(`/clip-delete @${clipId}`)
    await sendCommand('/apply')
    await expect.poll(async () => (record(await call('get_primary_sequence'))?.clips as unknown[]).length).toBe(0)
    const duplicate = record(await call('upload_file', { filename: 'delete-me.png', data: (await readFile(join(rootDir, 'image.png'))).toString('base64') }))!
    expect(duplicate.assetId).not.toBe(imageId)
    await page.reload()
    await sendCommand(`/delete ${String(duplicate.assetId)}`)
    await page.getByRole('button', { name: 'Review action', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm and run', exact: true }).click()
    await expect.poll(async () => JSON.stringify(await call('list_assets'))).not.toContain(String(duplicate.assetId))
    expect(JSON.stringify(await call('list_assets'))).toContain(imageId)
  }, 120_000)
})
