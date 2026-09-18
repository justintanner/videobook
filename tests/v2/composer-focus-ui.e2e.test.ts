import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import {
  availablePort,
  record,
  resultValue,
  startProcess,
  stopProcess,
  toolCalls,
  waitForHttp,
} from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

describe('composer focus through real workspace interactions', () => {
  let rootDir = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser
  let client: Client
  let page: Page
  let appUrl = ''
  let bookId = ''
  let notebookId = ''
  let videoCellId = ''
  let generationCellId = ''
  let imagePath = ''
  let catalogRequests = 0

  async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return resultValue(await client.callTool({
      name,
      arguments: { book_id: bookId, notebook_id: notebookId, ...args },
    }))
  }

  function input(): Locator {
    return page.getByLabel('Videobook command input', { exact: true })
  }

  function cell(id: string): Locator {
    return page.locator(`.react-flow__node[data-id="${id}"] .cell-node`)
  }

  async function focused(target: Locator): Promise<void> {
    await expect.poll(() => target.evaluate(element => ({
      focused: document.activeElement === element,
      active: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label'),
    })), { timeout: 15_000 }).toMatchObject({ focused: true })
  }

  async function ready(): Promise<void> {
    await input().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => input().isEnabled(), { timeout: 15_000 }).toBe(true)
  }

  async function selectProject(name: string): Promise<void> {
    await page.locator('.brand-project-menu-toggle').click()
    await page.locator('.book-project-select').filter({ hasText: name }).click()
    await expect.poll(() => page.locator('.book-project-menu').count(), { timeout: 15_000 }).toBe(0)
    await ready()
    await focused(input())
  }

  async function addImageSlot(): Promise<Locator> {
    await page.getByLabel('Add cell', { exact: true }).click()
    await page.getByLabel('Search cell types').fill('image')
    await page.locator('.canvas-add-menu').getByRole('button', { name: 'Image', exact: true }).click()
    const slot = page.getByLabel('Empty image media slot', { exact: true })
    await slot.waitFor()
    return slot
  }

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-focus-e2e-'))
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    const origin = `http://127.0.0.1:${mcpPort}`
    appUrl = `http://127.0.0.1:${vitePort}`
    const env = {
      ...process.env,
      PORT: String(mcpPort),
      VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
      VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime/app-state.json'),
    }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'composer-focus-e2e', version: '1.0.0' }, {
      capabilities: {},
      supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    await call('create_book', { name: 'focus-secondary' })
    const book = record(await call('create_book', { name: 'focus-primary' }))
    bookId = String(book?.bookId ?? '')
    const notebooks = await call('list_notebooks')
    notebookId = String(record(Array.isArray(notebooks) ? notebooks[0] : null)?.id ?? '')
    expect(bookId).not.toBe('')
    expect(notebookId).not.toBe('')
    const videoPath = join(rootDir, 'video.mp4')
    await promisify(execFile)(FFMPEG, [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=24:d=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
    ])
    imagePath = join(rootDir, 'image.png')
    await promisify(execFile)(FFMPEG, ['-y', '-i', videoPath, '-frames:v', '1', imagePath])
    const uploaded = record(await call('upload_file', {
      filename: 'video.mp4', data: (await readFile(videoPath)).toString('base64'),
    }))
    const assets = record(await call('list_assets'))
    const asset = (Array.isArray(assets?.assets) ? assets.assets : [])
      .map(record).find(value => value?.id === uploaded?.assetId)
    const video = record(await call('create_notebook_cell', {
      cell: {
        type: 'video', slot: { row: 0, column: 0 },
        output_artifact_id: asset?.artifact_id,
        inputs: { durationSeconds: 3 },
      },
    }))
    videoCellId = String(video?.id ?? '')
    const generation = record(await call('create_notebook_cell', {
      cell: { type: 'generate_image', slot: { row: 0, column: 1 }, prompt: 'A red cube' },
    }))
    generationCellId = String(generation?.id ?? '')
    vite = startProcess([
      'node_modules/vite/bin/vite.js', '--host', '127.0.0.1',
      '--port', String(vitePort), '--strictPort',
    ], { ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache') })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
  }, 60_000)

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    catalogRequests = 0
    page.on('request', request => {
      const body = request.postData()
      if (body?.includes('"slash_commands"')) catalogRequests += 1
    })
    await page.goto(appUrl)
    await ready()
  })

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      const path = `/tmp/videobook-focus-${task.name.replace(/[^a-z0-9]+/giu, '-').slice(0, 90)}`
      await page.screenshot({ path: `${path}.png` })
      await writeFile(`${path}.json`, JSON.stringify({ failures: task.result.errors, body: await page.locator('body').innerText() }, null, 2))
    }
    await page?.close()
    const notebook = record(await call('get_notebook'))
    for (const value of Array.isArray(notebook?.cells) ? notebook.cells : []) {
      const entry = record(value)
      if (entry?.id !== videoCellId && entry?.id !== generationCellId) {
        await call('delete_notebook_cell', { cell_id: entry?.id })
      }
    }
  })

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('starts in chat and preserves separate drafts through screen and project navigation', async () => {
    await focused(input())
    await page.keyboard.type('primary draft')
    expect(await input().textContent()).toBe('primary draft')
    for (const screen of ['Library', 'Jobs']) {
      await page.getByLabel(`Open ${screen}`, { exact: true }).click()
      if (screen === 'Library') {
        expect(await input().isVisible()).toBe(false)
        const search = page.getByLabel('Search the library')
        await search.fill('deliberate search')
        await focused(search)
      }
      await page.getByTitle('Open notebook', { exact: true }).click()
      await focused(input())
      expect(await input().textContent()).toBe('primary draft')
    }
    await selectProject('focus-secondary')
    expect(await input().textContent()).toBe('')
    await page.keyboard.type('secondary draft')
    await selectProject('focus-primary')
    expect(await input().textContent()).toBe('primary draft')
    await selectProject('focus-secondary')
    expect(await input().textContent()).toBe('secondary draft')
  })

  it('returns pointer canvas and toolbar actions to chat without losing selection or flooding catalogs', async () => {
    await focused(input())
    const initialCatalogRequests = catalogRequests
    await input().fill('draft')
    await cell(videoCellId).click()
    await focused(input())
    expect(await cell(videoCellId).getAttribute('data-selection')).toBe('primary')
    await page.keyboard.press('Backspace')
    expect(await input().textContent()).toBe('draf')
    expect(await cell(videoCellId).count()).toBe(1)
    // The inspector side column became the chat dock, so the toolbar is zoom
    // and selection now — there is no separate inspector to close.
    for (const label of ['Zoom out', 'Reset zoom', 'Clear selection']) {
      await page.getByLabel(label, { exact: true }).click()
      await focused(input())
    }
    await page.locator('.react-flow__pane').click({ position: { x: 850, y: 450 } })
    await focused(input())
    expect(await input().textContent()).toBe('draf')
    expect(catalogRequests).toBe(initialCatalogRequests)
  })

  it('selects a clip from its play ring, the way a picture selects from anywhere', async () => {
    await page.locator('.react-flow__pane').click({ position: { x: 850, y: 450 } })
    await focused(input())
    expect(await cell(videoCellId).getAttribute('data-selection')).toBeNull()
    // The ring sits dead centre of the tile: a press there plays the clip and
    // selects the cell, so a clip answers a press the way a picture does.
    await cell(videoCellId).getByLabel('Play @a1', { exact: true }).click()
    expect(await cell(videoCellId).getAttribute('data-selection')).toBe('primary')
    await expect.poll(async () => await cell(videoCellId)
      .locator('video')
      .evaluate(element =>
        element instanceof HTMLMediaElement ? !element.paused : false),
      { timeout: 15_000 }).toBe(true)
    await cell(videoCellId).getByLabel('Pause @a1', { exact: true }).click()
    await focused(input())
  })

  it('returns completed add, duplicate and delete operations to chat', async () => {
    await page.getByLabel('Add cell', { exact: true }).click()
    await page.getByLabel('Search cell types').fill('audio')
    await page.locator('.canvas-add-menu').getByRole('button', { name: 'Audio', exact: true }).click()
    await focused(input())
    expect(await page.locator('.cell-node').count()).toBe(3)
    await cell(videoCellId).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click()
    await focused(input())
    expect(await page.locator('.cell-node').count()).toBe(4)
    page.once('dialog', dialog => void dialog.accept())
    await page.getByLabel('Delete 1 selected cell', { exact: true }).click()
    await focused(input())
    expect(await page.locator('.cell-node').count()).toBe(3)
  })

  it('preserves keyboard menu navigation and cancels pending pointer focus before a rapid Tab', async () => {
    const add = page.getByLabel('Add cell', { exact: true })
    await add.focus()
    await page.keyboard.press('Enter')
    const search = page.getByLabel('Search cell types')
    await focused(search)
    await search.fill('split')
    await page.keyboard.press('Tab')
    await focused(page.locator('.canvas-add-menu').getByRole('button', { name: 'Split video', exact: true }))
    await page.keyboard.press('Escape')
    await focused(add)
    await page.keyboard.press('Tab')
    await focused(page.getByLabel('Auto-arrange notebook'))
    for (let index = 0; index < 12; index += 1) {
      await page.getByLabel('Reset zoom', { exact: true }).click()
      await page.keyboard.press('Tab')
      await page.waitForTimeout(35)
      expect(await input().evaluate(element => document.activeElement === element)).toBe(false)
    }
  })

  it('keeps native playback controls focused and returns pointer dismissal to chat', async () => {
    await cell(videoCellId).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open media', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const video = dialog.locator('video')
    await expect.poll(async () => await video.evaluate(element =>
      element instanceof HTMLMediaElement ? element.readyState : 0)).toBeGreaterThanOrEqual(2)
    await video.evaluate(element => {
      if (element instanceof HTMLMediaElement) element.pause()
    })
    await video.focus()
    await page.keyboard.press('Space')
    await expect.poll(async () => await video.evaluate(element =>
      element instanceof HTMLMediaElement ? element.paused : true)).toBe(false)
    await focused(video)
    await page.getByLabel('Close fullscreen preview').click()
    await focused(input())
  })

  it('returns a completed real image upload to chat and retains its draft', async () => {
    await input().fill('Continue after upload')
    const slot = await addImageSlot()
    const chooserReady = page.waitForEvent('filechooser')
    await slot.getByRole('button', { name: /Add image/ }).click()
    const chooser = await chooserReady
    await chooser.setFiles(imagePath)
    await slot.waitFor({ state: 'hidden' })
    await focused(input())
    expect(await input().textContent()).toBe('Continue after upload')
    const notebook = record(await call('get_notebook'))
    const image = (Array.isArray(notebook?.cells) ? notebook.cells : [])
      .map(record).find(value => value?.type === 'image')
    expect(image?.output_artifact_id).toBeTruthy()
  })

  it('keeps modal search focused and cancels stale dismissal before the next menu or Tab', async () => {
    const slot = await addImageSlot()
    const opener = slot.getByRole('button', { name: 'Search library', exact: true })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: 'Choose image media' })
    const search = dialog.getByLabel('Search library', { exact: true })
    await search.fill('Keep searching')
    await focused(search)
    await page.getByLabel('Close media library').click()
    await cell(videoCellId).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Cell actions for @a1' })
    await focused(menu.getByRole('menuitem').first())
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    await opener.focus()
    await page.keyboard.press('Enter')
    await focused(search)
    await page.keyboard.press('Escape')
    await focused(opener)
    await page.keyboard.press('Tab')
    const afterTab = await page.evaluate(() => document.activeElement?.outerHTML)
    await page.waitForTimeout(50)
    expect(await page.evaluate(() => document.activeElement?.outerHTML)).toBe(afterTab)
  })

  it('returns a real rejected command to chat', async () => {
    await input().fill('/invert missing-asset-for-focus')
    await page.getByLabel('Send command', { exact: true }).click()
    await page.locator('.command-result-error').waitFor()
    await ready()
    await focused(input())
    await page.keyboard.type('Try again')
    expect(await input().textContent()).toBe('Try again')
  })

  it('does not submit chat while native IME composition is active', async () => {
    await focused(input())
    await input().fill('/notebooks ')
    let notebookReads = 0
    page.on('request', request => {
      if (request.postData()?.includes('"list_notebooks"')) notebookReads += 1
    })
    const session = await page.context().newCDPSession(page)
    await session.send('Input.imeSetComposition', { text: '測試', selectionStart: 2, selectionEnd: 2 })
    expect(await input().textContent()).toBe('/notebooks 測試')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
    expect(await input().textContent()).toBe('/notebooks 測試')
    expect(notebookReads).toBe(0)
    await focused(input())
    await session.detach()
  })

  it('does not steal focus from an editor when an earlier real command finishes', async () => {
    await cell(generationCellId).click()
    const prompt = page.getByLabel('Prompt', { exact: true })
    await prompt.waitFor()
    let release: () => void = () => undefined
    let arrived: () => void = () => undefined
    const held = new Promise<void>(resolve => { release = resolve })
    const responseReady = new Promise<void>(resolve => { arrived = resolve })
    await page.route('**/mcp', async route => {
      const calls = toolCalls(route.request().postDataJSON())
      if (!calls.some(call => call.name === 'list_notebooks')) {
        await route.continue()
        return
      }
      const response = await route.fetch()
      arrived()
      await held
      await route.fulfill({ response })
    })
    try {
      await input().fill('/notebooks')
      await page.getByLabel('Send command', { exact: true }).click()
      await responseReady
      await prompt.fill('Keep editing this prompt')
      release()
      await ready()
      await focused(prompt)
      expect(await prompt.inputValue()).toBe('Keep editing this prompt')
    } finally {
      release()
      await page.unroute('**/mcp')
    }
  })

  it('preserves chat draft and caret while a real external notebook update arrives', async () => {
    await input().fill('Draft remains intact')
    await input().evaluate(element => {
      const range = document.createRange()
      range.setStart(element.firstChild!, 4)
      range.collapse(true)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    })
    const created = record(await call('create_notebook_cell', {
      cell: { type: 'prompt', slot: { row: 7, column: 7 }, prompt: 'External update' },
    }))
    await cell(String(created?.id)).waitFor({ timeout: 15_000 })
    await focused(input())
    expect(await input().textContent()).toBe('Draft remains intact')
    expect(await input().evaluate(element =>
      element.contains(window.getSelection()?.anchorNode ?? null) ? window.getSelection()?.anchorOffset : null)).toBe(4)
  })

  it('does not force chat focus after a touch action', async () => {
    await page.close()
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
    await ready()
    expect(await input().evaluate(element => document.activeElement === element)).toBe(false)
    await page.getByLabel('Reset zoom', { exact: true }).tap()
    await page.waitForTimeout(50)
    expect(await input().evaluate(element => document.activeElement === element)).toBe(false)
  })
})
