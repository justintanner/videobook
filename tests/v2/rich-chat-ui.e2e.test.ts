import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { MANAGED_ENV_KEYS } from '../../server/src/env-secrets.js'
import { availablePort, record, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { ObservedToolCall, StartedProcess } from './e2e-harness.js'

const MCP_ROUNDTRIP_MS = 15_000

describe('rich chat references with real notebook media', () => {
  let rootDir = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser
  let client: Client
  let page: Page
  let appUrl = ''
  let bookId = ''
  let notebookId = ''
  let imageId = ''
  let secondBookId = ''
  let secondImageId = ''
  let calls: ObservedToolCall[] = []
  let errors: string[] = []

  async function call(name: string, args: Record<string, unknown> = {}) {
    return resultValue(await client.callTool({ name, arguments: { book_id: bookId, ...args } }))
  }

  const input = () => page.getByLabel('Videobook command input', { exact: true })

  async function selectAll(locator: Locator) {
    await locator.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    })
  }

  async function firstTextCaret(offset: number) {
    await input().evaluate((element, position) => {
      const range = document.createRange()
      range.setStart(element.firstChild!, position)
      range.collapse(true)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }, offset)
  }

  async function chooseBook(name: string) {
    await page.locator('.brand-project-menu-toggle').click()
    await page.locator('.book-project-select').filter({ hasText: name }).click()
    await expect.poll(() => page.locator('.book-project-menu').count(), { timeout: MCP_ROUNDTRIP_MS }).toBe(0)
    await expect.poll(() => input().isEnabled(), { timeout: 15_000 }).toBe(true)
  }

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-rich-chat-'))
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    const origin = `http://127.0.0.1:${mcpPort}`
    appUrl = `http://127.0.0.1:${vitePort}`
    const env = {
      ...process.env, ...Object.fromEntries(MANAGED_ENV_KEYS.map(key => [key, ''])),
      PORT: String(mcpPort), VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
      VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime/app-state.json'),
      VIDEOBOOK_ENV_PATH: join(rootDir, '.env'), VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
    }
    await writeFile(env.VIDEOBOOK_ENV_PATH, '')
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'rich-chat-e2e', version: '1.0.0' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    bookId = String(record(await call('create_book', { name: 'rich-chat-primary' }))?.bookId)
    const notebooks = await call('list_notebooks')
    notebookId = String(record(Array.isArray(notebooks) ? notebooks[0] : null)?.id)
    const videoPath = join(rootDir, 'video.mp4')
    const imagePath = join(rootDir, 'image.png')
    const audioPath = join(rootDir, 'audio.wav')
    const exec = promisify(execFile)
    await exec(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath])
    await exec(FFMPEG, ['-y', '-i', videoPath, '-frames:v', '1', imagePath])
    await exec(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', audioPath])
    const imageData = (await readFile(imagePath)).toString('base64')
    imageId = String(record(await call('upload_file', { filename: 'image.png', data: imageData }))?.assetId)
    const videoId = String(record(await call('upload_file', { filename: 'video.mp4', data: (await readFile(videoPath)).toString('base64') }))?.assetId)
    const audioId = String(record(await call('upload_file', { filename: 'audio.wav', data: (await readFile(audioPath)).toString('base64') }))?.assetId)
    for (const assetId of [imageId, videoId]) await call('rename_asset', { asset_id: assetId, new_name: 'Shared label' })
    for (const [column, type, artifactId] of [[0, 'image', imageId], [1, 'image', imageId], [2, 'video', videoId], [3, 'audio', audioId]] as const) {
      await call('create_notebook_cell', { notebook_id: notebookId, cell: { type, slot: { row: 0, column }, output_artifact_id: artifactId } })
    }
    await call('create_notebook_cell', { notebook_id: notebookId, cell: { type: 'prompt', label: 'Shared label', slot: { row: 63, column: 7 }, prompt: 'A quiet scene' } })
    secondBookId = String(record(await call('create_book', { name: 'rich-chat-secondary' }))?.bookId)
    const secondNotebooks = await call('list_notebooks', { book_id: secondBookId })
    const secondNotebookId = String(record(Array.isArray(secondNotebooks) ? secondNotebooks[0] : null)?.id)
    secondImageId = String(record(await call('upload_file', { book_id: secondBookId, filename: 'other.png', data: imageData }))?.assetId)
    await call('create_notebook_cell', { book_id: secondBookId, notebook_id: secondNotebookId, cell: { type: 'image', slot: { row: 0, column: 0 }, output_artifact_id: secondImageId } })
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { ...env, VIDEOBOOK_SERVER_URL: origin })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
  }, 60_000)

  beforeEach(async () => {
    calls = []
    errors = []
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && /React|unmount|rendering/u.test(message.text())) errors.push(message.text()) })
    page.on('request', request => {
      if (request.url().endsWith('/mcp') && request.method() === 'POST') calls.push(...toolCalls(request.postDataJSON()))
    })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
    await expect.poll(() => input().isEnabled(), { timeout: 15_000 }).toBe(true)
  })

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      const path = `/tmp/videobook-rich-chat-${task.name.replace(/[^a-z0-9]+/giu, '-').slice(0, 90)}`
      await page.screenshot({ path: `${path}.png` })
      await writeFile(`${path}.json`, JSON.stringify({ failures: task.result?.errors, errors, calls, body: await page.locator('body').innerText() }, null, 2))
    }
    await page?.close()
    expect(errors).toEqual([])
  })

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    await rm(rootDir, { recursive: true, force: true })
  })

  it('shows real image and video thumbnails, distinct shared references and non-media fallbacks', async () => {
    await input().fill('Use @a')
    const options = page.getByRole('listbox', { name: 'Command suggestions' }).getByRole('option')
    for (const token of ['@a1', '@a2', '@a3']) {
      const option = options.filter({ has: page.getByText(token, { exact: true }) })
      expect(await option.textContent()).toContain('Shared label')
      await expect.poll(() => option.locator('img').evaluate(image => image instanceof HTMLImageElement && image.naturalWidth > 0), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
    }
    expect(await options.filter({ has: page.getByText('@a4', { exact: true }) }).textContent()).toContain('AUDIO')
    expect(await options.filter({ has: page.getByText('@a5', { exact: true }) }).textContent()).toContain('Empty grid square')
    await options.filter({ has: page.getByText('@a2', { exact: true }) }).click()
    await expect.poll(() => input().textContent()).toBe('Use @a2 ')
    expect(await input().locator('[data-reference="@a2"] img').count()).toBe(1)
    await input().fill('Compare @a1, @a2, @a3, @a4, @a5 and @bl8.')
    await expect.poll(() => input().locator('[data-reference]').count()).toBe(6)
    expect(await input().locator('video, audio').count()).toBe(0)
    expect(await input().locator('[data-reference="@a4"] svg').count()).toBe(1)
    expect(await input().locator('[data-reference="@bl8"]').getAttribute('aria-label')).toContain('PROMPT')
    expect(await input().ariaSnapshot()).toContain('img "@a1 · Shared label · IMAGE"')
  })

  it('inserts references at a mid-sentence caret and deletes chips atomically', async () => {
    await input().fill('Before @a, after @bl8.')
    await firstTextCaret(9)
    await input().press('ArrowLeft')
    await input().press('ArrowRight')
    const option = page.getByRole('option').filter({ has: page.getByText('@a2', { exact: true }) })
    await option.click()
    await expect.poll(() => input().textContent()).toBe('Before @a2, after @bl8.')
    await input().locator('[data-reference="@a2"]').evaluate(element => {
      const range = document.createRange()
      range.setStartAfter(element)
      range.collapse(true)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    })
    await input().press('Backspace')
    await expect.poll(() => input().textContent()).toBe('Before , after @bl8.')
    await input().press('ControlOrMeta+Z')
    await expect.poll(() => input().textContent()).toBe('Before @a2, after @bl8.')
  })

  it('copies and cuts canonical text, undoes edits and pastes plain text without markup', async () => {
    const value = 'Compare @a1, (@bl8) and @a3.'
    await input().fill(value)
    await expect.poll(() => input().textContent()).toBe(value)
    await selectAll(input())
    await input().press('ControlOrMeta+C')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value)
    await input().press('ControlOrMeta+X')
    await expect.poll(() => input().textContent()).toBe('')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value)
    await input().press('ControlOrMeta+Z')
    await expect.poll(() => input().textContent()).toBe(value)
    await input().press('ControlOrMeta+Shift+Z')
    await expect.poll(() => input().textContent()).toBe('')
    await page.evaluate(async () => navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob(['Use @a2 <b>literal</b>'], { type: 'text/plain' }),
      'text/html': new Blob(['<b>wrong HTML</b><img src="https://example.invalid/never-load">'], { type: 'text/html' }),
    })]))
    await input().press('ControlOrMeta+V')
    await expect.poll(() => input().textContent()).toBe('Use @a2 <b>literal</b>')
    expect(await input().locator('b').count()).toBe(0)
    expect(await input().locator('[data-reference="@a2"]').count()).toBe(1)
  })

  it('keeps action queries separate from the draft and prepares without execution or history writes', async () => {
    await input().fill('Keep @a1 in this draft')
    await firstTextCaret(2)
    await input().press('ControlOrMeta+Shift+K')
    await page.getByRole('region', { name: 'Actions', exact: true }).waitFor()
    await input().fill('delete book')
    await input().press('Escape')
    await expect.poll(() => input().textContent()).toBe('Keep @a1 in this draft')
    expect(await input().evaluate(() => window.getSelection()?.anchorOffset)).toBe(2)
    const start = calls.length
    await page.getByRole('button', { name: 'Open actions', exact: true }).click()
    await input().fill('/delete-book')
    await page.locator('.workspace-actions-list [data-command="/delete-book"]').click()
    await expect.poll(() => input().textContent()).toBe('/delete-book ')
    expect(calls.slice(start).filter(call => ['record_prompt', 'delete_book', 'chat'].includes(call.name))).toEqual([])
    expect(await page.getByRole('dialog', { name: 'Workspace actions' }).count()).toBe(0)
    expect(await page.locator('.header-navigation [aria-label="Open actions"]').count()).toBe(0)
    await input().press('ControlOrMeta+Z')
    await expect.poll(() => input().textContent()).toBe('Keep @a1 in this draft')
  })

  it('commits IME text before creating chips and preserves references through readline edits', async () => {
    const session = await page.context().newCDPSession(page)
    await input().focus()
    await session.send('Input.imeSetComposition', { text: '猫 @a1', selectionStart: 5, selectionEnd: 5 })
    await expect.poll(() => input().textContent()).toBe('猫 @a1')
    expect(await input().locator('[data-reference]').count()).toBe(0)
    await input().dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    expect(calls.filter(call => ['record_prompt', 'chat'].includes(call.name))).toEqual([])
    await session.send('Input.insertText', { text: '猫 @a1' })
    await expect.poll(() => input().locator('[data-reference="@a1"]').count()).toBe(1)
    await input().press('Escape')
    await input().press('Control+U')
    await expect.poll(() => input().textContent()).toBe('')
    await input().press('Control+Y')
    await expect.poll(() => input().textContent()).toBe('猫 @a1')
    await input().press('Control+A')
    await input().press('Control+K')
    await expect.poll(() => input().textContent()).toBe('')
    await input().press('Control+Y')
    await expect.poll(() => input().textContent()).toBe('猫 @a1')
    expect(await input().locator('[data-reference="@a1"]').count()).toBe(1)
    await session.detach()
  })

  it('records canonical history and resolves the selected shared cell to its real asset', async () => {
    await input().fill('/asset-manifest @a2')
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Workspace actions' })
    await dialog.waitFor()
    await expect.poll(() => dialog.getByRole('combobox', { name: 'Media', exact: true }).inputValue(), { timeout: MCP_ROUNDTRIP_MS }).toBe(imageId)
    const prompts = calls.filter(call => call.name === 'record_prompt').map(call => call.arguments.prompt)
    expect(prompts).toEqual(['/asset-manifest @a2'])
    expect(JSON.stringify(prompts)).not.toContain('Shared label')
    expect(JSON.stringify(prompts)).not.toContain('/files/')
    expect(JSON.stringify(await call('list_prompt_history', { surface: 'chat', limit: 10 }))).toContain('/asset-manifest @a2')
  })

  it('falls back after failed image loads without adding media players', async () => {
    await page.route('**/files/**', route => route.request().resourceType() === 'image' ? route.abort('failed') : route.continue())
    await page.reload()
    await expect.poll(() => input().isEnabled(), { timeout: 15_000 }).toBe(true)
    await input().fill('Use @a1 and @a3')
    for (const token of ['@a1', '@a3']) {
      await expect.poll(() => input().locator(`[data-reference="${token}"] img`).count()).toBe(0)
      expect(await input().locator(`[data-reference="${token}"] svg`).count()).toBe(1)
    }
    expect(await input().locator('video, audio').count()).toBe(0)
  })

  it('restores separate project drafts with current thumbnails and refreshed display labels', async () => {
    await input().fill('Primary @a1')
    await chooseBook('rich-chat-secondary')
    expect(await input().textContent()).toBe('')
    await input().fill('Secondary @a1')
    await expect.poll(() => input().locator('[data-reference="@a1"] img').getAttribute('src'), { timeout: MCP_ROUNDTRIP_MS }).toContain(secondImageId)
    expect(await input().locator('[data-reference="@a1"] img').getAttribute('src')).toContain(secondBookId)
    await chooseBook('rich-chat-primary')
    await expect.poll(() => input().textContent(), { timeout: MCP_ROUNDTRIP_MS }).toBe('Primary @a1')
    await expect.poll(() => input().locator('[data-reference="@a1"] img').getAttribute('src'), { timeout: MCP_ROUNDTRIP_MS }).toContain(imageId)
    await call('rename_asset', { asset_id: imageId, new_name: 'Updated display label' })
    await expect.poll(() => input().locator('[data-reference="@a1"]').getAttribute('aria-label'), { timeout: 15_000 }).toContain('Updated display label')
    expect(await input().textContent()).toBe('Primary @a1')
  })

  it('keeps chips, controls and action results usable in narrow, short and zoomed windows', async () => {
    const evidence = process.env.VIDEOBOOK_UI_EVIDENCE_DIR ?? join(rootDir, 'evidence')
    await mkdir(evidence, { recursive: true })
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 500 }, { width: 667, height: 375 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
      await page.setViewportSize(viewport)
      await input().fill('Compare @a1 with @a2, @a3, @a4 and @bl8. Keep each reference distinct.')
      await input().press('Escape')
      expect(await page.locator('html').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true)
      const send = page.getByRole('button', { name: 'Send command', exact: true })
      expect(await send.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
          && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      })).toBe(true)
      await page.screenshot({ path: join(evidence, `references-${viewport.width}.png`) })
      await page.getByRole('button', { name: 'Open actions', exact: true }).click()
      const panel = page.locator('.composer-actions-panel')
      expect(await panel.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && element.scrollWidth <= element.clientWidth
      })).toBe(true)
      await input().press('End')
      const active = page.locator('.workspace-actions-list [aria-selected="true"]')
      await expect.poll(() => active.evaluate(element => {
        const parent = element.parentElement!.getBoundingClientRect()
        const rect = element.getBoundingClientRect()
        return rect.top >= parent.top - 1 && rect.bottom <= parent.bottom + 1
      }), { message: `Selected action stays visible at ${viewport.width}x${viewport.height}` }).toBe(true)
      await page.screenshot({ path: join(evidence, `actions-${viewport.width}.png`) })
      await input().press('Escape')
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('html').evaluate(element => { element.style.zoom = '2' })
    expect(await page.locator('html').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true)
    await input().focus()
    await input().press('Tab')
    expect(await page.getByLabel('Chat model').evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await input().evaluate(element => document.activeElement === element)).toBe(true)
  })

  it('closes the inspector and highlights the output instead of selecting it after Generate', async () => {
    await page.addInitScript(() => localStorage.setItem('videobook.cloud-generation-consent', 'accepted'))
    const created = record(await call('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'highlight producer',
        slot: { row: 1, column: 0 },
        prompt: 'a green lighthouse at dusk',
        provider: 'kie',
        model: 'kie:nano-banana-pro',
        operation: 'text_to_image',
        tool: 'generate_image',
      },
    }))
    const producerId = String(created?.id)
    await page.reload()
    await expect.poll(() => input().isEnabled(), { timeout: 15_000 }).toBe(true)
    const producer = page.locator(`.react-flow__node[data-id="${producerId}"]`)
    await producer.waitFor({ state: 'visible', timeout: 30_000 })
    await producer.click()
    await expect.poll(() => producer.locator('.cell-node').getAttribute('class'), { timeout: 10_000 }).toContain('cell-node-selected')
    const dock = page.locator('.composer-notebook-dock')
    await dock.getByRole('button', { name: /Generate/ }).click()
    // The inspector and its generation preview drop instead of following the
    // output cell, and the queued output is highlighted unselected.
    await expect.poll(() => producer.locator('.cell-node').getAttribute('class'), { timeout: 15_000 }).not.toContain('cell-node-selected')
    await expect.poll(() => page.locator('.generation-cell-inspector').count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(
      () => page.locator('.cell-node.cell-node-highlight').count(),
      { timeout: 15_000 },
    ).toBeGreaterThan(0)
    expect(await page.locator('.cell-node.cell-node-highlight.cell-node-selected').count()).toBe(0)
    await expect.poll(async () => JSON.stringify(await call('list_jobs')), { timeout: 90_000 }).not.toMatch(/"state":"(queued|running)"/)
    await expect.poll(
      () => page.locator('.cell-node.cell-node-error').count(),
      { timeout: 30_000 },
    ).toBeGreaterThan(0)
  })

  it('shows the generating layout while a selected output runs and offers Retry after failure', async () => {
    await page.addInitScript(() => localStorage.setItem('videobook.cloud-generation-consent', 'accepted'))
    const created = record(await call('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_video',
        label: 'generating dock producer',
        slot: { row: 2, column: 1 },
        prompt: 'a slow dolly through a pine forest',
        provider: 'kie',
        model: 'kie:bytedance/seedance-2-5',
        operation: 'text_to_video',
        tool: 'generate_video',
      },
    }))
    const producerId = String(created?.id)
    await page.reload()
    await expect.poll(() => input().isEnabled(), { timeout: 15_000 }).toBe(true)
    const producer = page.locator(`.react-flow__node[data-id="${producerId}"]`)
    await producer.waitFor({ state: 'visible', timeout: 30_000 })
    // Headless chromium occasionally flips navigator.onLine mid-session,
    // which correctly blocks cloud generation; pin it for this run.
    const devtools = await page.context().newCDPSession(page)
    await devtools.send('Network.enable')
    await devtools.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await producer.click()
    const dock = page.locator('.composer-notebook-dock')
    await dock.getByRole('button', { name: /Generate/ }).click()
    // The run is accepted and the output cell appears; the offline job fails
    // within seconds, so address the output by id rather than by its brief
    // queued styling.
    let outputCellId = ''
    await expect.poll(async () => {
      const notebooks = await call('list_notebooks')
      const document = (Array.isArray(notebooks) ? notebooks : [])
        .find((candidate: { id?: string }) => candidate.id === notebookId)
      const output = (document?.cells ?? []).find(
        (candidate: { inputs?: { mediaRole?: string } }) =>
          candidate.inputs?.mediaRole === 'generate-video-output',
      )
      outputCellId = output ? String(output.id) : ''
      return outputCellId.length
    }, { timeout: 30_000 }).toBeGreaterThan(0)
    await page.locator(`.react-flow__node[data-id="${outputCellId}"]`).click()
    const generating = page.locator('.inspector-media-generating')
    await expect.poll(() => generating.count(), { timeout: 15_000 }).toBe(1)
    // Same layout across queued, generating and failed: aspect-true
    // placeholder, the producer's prompt, and none of the ready chrome.
    expect(await generating.locator('.inspector-media-placeholder').count()).toBe(1)
    expect(await generating.innerText()).toMatch(/a slow dolly through a pine forest/i)
    expect(await generating.getByRole('button', { name: '@c2 Generate video', exact: true }).isVisible()).toBe(true)
    await expect.poll(() => generating.getAttribute('data-generation'), { timeout: 90_000 }).toBe('failed')
    expect(await generating.innerText()).toMatch(/provider|key|missing|failed/i)
    // Retry re-runs the producer: each run allocates its own output cell, so
    // the fresh one appears and opens the same generating dock.
    await generating.getByRole('button', { name: 'Retry' }).click()
    let retryOutputId = ''
    await expect.poll(async () => {
      const notebooks = await call('list_notebooks')
      const document = (Array.isArray(notebooks) ? notebooks : [])
        .find((candidate: { id?: string }) => candidate.id === notebookId)
      const retryOutput = (document?.cells ?? []).find(
        (candidate: { id?: string; inputs?: { mediaRole?: string } }) =>
          candidate.inputs?.mediaRole === 'generate-video-output'
          && candidate.id !== outputCellId,
      )
      retryOutputId = retryOutput ? String(retryOutput.id) : ''
      return retryOutputId.length
    }, { timeout: 60_000 }).toBeGreaterThan(0)
    await page.locator(`.react-flow__node[data-id="${retryOutputId}"]`).click()
    const retryDock = page.locator('.inspector-media-generating')
    await expect.poll(() => retryDock.count(), { timeout: 15_000 }).toBe(1)
    const source = retryDock.getByRole('button', { name: '@c2 Generate video', exact: true })
    expect(await source.isVisible()).toBe(true)
    await expect.poll(
      () => retryDock.getAttribute('data-generation'),
      { timeout: 90_000 },
    ).toBe('failed')
    await source.click()
    await expect.poll(() => producer.locator('.cell-node').getAttribute('class')).toContain('cell-node-selected')
    expect(await dock.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue()).toBe('a slow dolly through a pine forest')
  })

  it('keeps global actions available when no books exist', async () => {
    await call('delete_book', { book_id: secondBookId, confirm_name: 'rich-chat-secondary' })
    await call('delete_book', { confirm_name: 'rich-chat-primary' })
    await page.reload()
    await expect.poll(() => input().getAttribute('aria-disabled')).toBe('true')
    expect(await page.getByLabel('Open Assets', { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Open actions', exact: true }).click()
    await input().fill('create book')
    await page.locator('.workspace-actions-list [data-command="/create-book"]').click()
    await expect.poll(() => input().isEnabled(), { timeout: 15_000 }).toBe(true)
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Workspace actions' })
    await expect.poll(() => dialog.getByRole('textbox', { name: 'Name', exact: true }).isEnabled()).toBe(true)
    expect(calls.filter(call => call.name === 'create_book')).toEqual([])
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('button', { name: 'Open actions', exact: true }).evaluate(element => document.activeElement === element)).toBe(true)
    expect(await page.getByRole('button', { name: 'Send command', exact: true }).isDisabled()).toBe(true)
  })
})
