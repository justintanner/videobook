import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page, Route } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface StartedProcess {
  child: ChildProcessWithoutNullStreams
  output: string[]
}

interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not reserve a port')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

function startProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
): StartedProcess {
  const output: string[] = []
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (data: Buffer) => output.push(data.toString()))
  child.stderr.on('data', (data: Buffer) => output.push(data.toString()))
  return { child, output }
}

async function waitForHttp(
  url: string,
  processState: StartedProcess,
  acceptedStatus: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (processState.child.exitCode !== null) {
      throw new Error(`Process exited during startup:\n${processState.output.join('')}`)
    }
    try {
      const response = await fetch(url)
      if (response.status === acceptedStatus) return
    } catch {
      await wait(100)
    }
  }
  throw new Error(`Process did not start:\n${processState.output.join('')}`)
}

async function stopProcess(processState: StartedProcess | undefined): Promise<void> {
  if (!processState || processState.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => {
    processState.child.once('exit', () => resolve())
  })
  processState.child.kill('SIGINT')
  const stopped = await Promise.race([
    exited.then(() => true),
    wait(5_000).then(() => false),
  ])
  if (stopped) return
  processState.child.kill('SIGKILL')
  await exited
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function resultValue(value: unknown): unknown {
  const result = record(value)
  const content = Array.isArray(result?.content) ? result.content : []
  const textItem = content.map(record).find((item) => item?.type === 'text')
  const text = typeof textItem?.text === 'string' ? textItem.text : ''
  if (!text || result?.isError === true) {
    throw new Error(text || 'MCP tool returned no result')
  }
  return JSON.parse(text) as unknown
}

function toolCalls(value: unknown): ToolCall[] {
  const envelopes = Array.isArray(value) ? value : [value]
  return envelopes.flatMap((entry) => {
    const envelope = record(entry)
    const params = record(envelope?.params)
    const args = record(params?.arguments)
    return envelope?.method === 'tools/call'
      && typeof params?.name === 'string'
      && args
      ? [{ name: params.name, arguments: args }]
      : []
  })
}

async function requestBody(route: Route): Promise<unknown> {
  try {
    return route.request().postDataJSON() as unknown
  } catch {
    return null
  }
}

describe('chat composer browser flow', () => {
  let rootDir = ''
  let mcpProcess: StartedProcess | undefined
  let viteProcess: StartedProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let appUrl = ''
  let reviewGenerationCellId = ''
  const observedCalls: ToolCall[] = []
  let delayedBootstrap = false

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-chat-ui-e2e-'))
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    const mcpOrigin = `http://127.0.0.1:${mcpPort}`
    appUrl = `http://127.0.0.1:${vitePort}`
    mcpProcess = startProcess(
      ['--import', 'tsx', 'server/src/index.ts'],
      {
        ...process.env,
        PORT: String(mcpPort),
        VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime', 'app-state.json'),
        VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
      },
    )
    await waitForHttp(`${mcpOrigin}/healthz`, mcpProcess, 200)
    const client = new Client(
      { name: 'videobook-chat-ui-e2e', version: '1.0.0' },
      {
        capabilities: {},
        supportedProtocolVersions: ['2026-07-28'],
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    )
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp`)))
    await client.callTool({ name: 'create_book', arguments: { slug: 'chat-ui-e2e' } })
    const booksValue = resultValue(await client.callTool({
      name: 'list_books',
      arguments: { sort: 'newest' },
    }))
    const book = (Array.isArray(booksValue) ? booksValue : [])
      .map(record)
      .find((entry) => entry?.slug === 'chat-ui-e2e')
    const bookId = typeof book?.bookId === 'string' ? book.bookId : ''
    if (!bookId) throw new Error('Could not create browser fixture book')
    const notebooksValue = resultValue(await client.callTool({
      name: 'list_notebooks',
      arguments: { book_id: bookId },
    }))
    const notebook = (Array.isArray(notebooksValue) ? notebooksValue : [])
      .map(record)
      .find(Boolean)
    const notebookId = typeof notebook?.id === 'string' ? notebook.id : ''
    if (!notebookId) throw new Error('Could not create browser fixture notebook')
    const createCell = async (cell: Record<string, unknown>): Promise<string> => {
      const value = record(resultValue(await client.callTool({
        name: 'create_notebook_cell',
        arguments: { book_id: bookId, notebook_id: notebookId, cell },
      })))
      const id = typeof value?.id === 'string' ? value.id : ''
      if (!id) throw new Error('Could not create browser fixture cell')
      return id
    }
    const videoCellId = await createCell({
      type: 'video',
      slug: 'vid-source-one',
      slot: { row: 0, column: 0 },
    })
    const imageCellId = await createCell({
      type: 'image',
      slug: 'img-source-two',
      slot: { row: 0, column: 2 },
    })
    const generationCellId = await createCell({
      type: 'generate_video',
      slug: 'generate-video-target',
      slot: { row: 1, column: 0 },
      provider: 'kie',
      model: 'Seedance2MiniInputSchema',
      operation: 'image_to_video',
      tool: 'generate_kie_seedance_2_0_mini_video',
      inputs: { state: 'running' },
    })
    reviewGenerationCellId = await createCell({
      type: 'generate_image',
      slug: 'generate-image-review',
      slot: { row: 1, column: 2 },
      prompt: 'A moonlit garden ready for review',
    })
    for (const connection of [
      { source_cell_id: videoCellId, target_input: 'video' },
      { source_cell_id: imageCellId, target_input: 'image' },
    ]) {
      resultValue(await client.callTool({
        name: 'connect_notebook_cells',
        arguments: {
          book_id: bookId,
          notebook_id: notebookId,
          target_cell_id: generationCellId,
          ...connection,
        },
      }))
    }
    for (const prompt of [
      'history-oldest',
      'history-middle',
      'history-newest',
    ]) {
      resultValue(await client.callTool({
        name: 'record_prompt',
        arguments: {
          book_id: bookId,
          surface: 'chat',
          prompt,
        },
      }))
    }
    await client.close()
    viteProcess = startProcess(
      [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort)],
      {
        ...process.env,
        VIDEOBOOK_SERVER_URL: mcpOrigin,
      },
    )
    await waitForHttp(appUrl, viteProcess, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.route('**/mcp', async (route) => {
      const calls = toolCalls(await requestBody(route))
      observedCalls.push(...calls)
      if (!delayedBootstrap && calls.some((call) => call.name === 'list_books')) {
        delayedBootstrap = true
        await wait(700)
      }
      if (calls.some((call) => call.name === 'chat')) {
        await wait(850)
      }
      await route.continue()
    })
  }, 120_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await stopProcess(viteProcess)
    await stopProcess(mcpProcess)
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('keeps compact canvas controls clear of cells and narrows the inspector', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const canvas = page.locator('.canvas')
    const toolbar = page.getByLabel('Notebook canvas controls')
    const firstCell = page.locator('.cell-node').filter({ hasText: '@a1' })
    await toolbar.waitFor({ state: 'visible' })
    await firstCell.waitFor({ state: 'visible' })
    const canvasBox = await canvas.boundingBox()
    const toolbarBox = await toolbar.boundingBox()
    const firstCellBox = await firstCell.boundingBox()
    if (!canvasBox || !toolbarBox || !firstCellBox) {
      throw new Error('Could not measure notebook layout')
    }
    expect(toolbarBox.x).toBeLessThan(canvasBox.x + canvasBox.width / 2)
    expect(toolbarBox.x - canvasBox.x).toBeGreaterThanOrEqual(20)
    expect(toolbarBox.x - canvasBox.x).toBeLessThanOrEqual(28)
    expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(firstCellBox.y)

    const addCell = page.locator('.canvas-add-menu > summary')
    expect(await addCell.getAttribute('aria-label')).toBe('Add cell')
    expect((await addCell.textContent())?.trim()).toBe('')
    await addCell.click()
    await page.locator('.canvas-add-menu > div').waitFor({ state: 'visible' })
    await addCell.click()

    await page.getByLabel('Open inspector').click()
    await wait(250)
    const inspectorBox = await page.locator('.inspector').boundingBox()
    expect(inspectorBox?.width).toBeGreaterThanOrEqual(280)
    expect(inspectorBox?.width).toBeLessThanOrEqual(320)
  }, 60_000)

  it('recalls failed commands backwards and restores the unsent draft', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const failedCommand = 'history command expected to fail'
    await input.fill(failedCommand)
    await page.getByLabel('Send command').click()
    await page.locator('.command-result-error').waitFor({ state: 'visible' })
    await expect.poll(async () => await input.isEnabled()).toBe(true)
    await expect.poll(async () => await input.inputValue()).toBe('')

    for (const expected of [
      failedCommand,
      'history-newest',
      'history-middle',
      'history-oldest',
    ]) {
      await input.press('ArrowUp')
      await expect.poll(async () => await input.inputValue()).toBe(expected)
    }
    for (const expected of [
      'history-middle',
      'history-newest',
      failedCommand,
      '',
    ]) {
      await input.press('ArrowDown')
      await expect.poll(async () => await input.inputValue()).toBe(expected)
    }
  }, 60_000)

  it('shows MCP motion and sends the selected model through the real UI', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    const startup = page.locator('#startup-shell')
    await startup.waitFor({ state: 'visible' })
    await expect.poll(async () => await startup.textContent()).toContain('Loading workspace via MCP')
    const startupAnimation = await page.locator('#startup-signal').evaluate((element) =>
      window.getComputedStyle(element, '::after').animationName)
    expect(startupAnimation).toContain('startup-scan')

    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)
    const routePaths = page.locator('.notebook-flow .workflow-edge .react-flow__edge-path')
    await expect.poll(async () => await routePaths.count()).toBe(2)
    const routeStyles = await routePaths.evaluateAll((paths) => paths.map((path) => ({
      d: path.getAttribute('d'),
      stroke: window.getComputedStyle(path).stroke,
      strokeWidth: window.getComputedStyle(path).strokeWidth,
    })))
    expect(routeStyles).toHaveLength(2)
    expect(routeStyles.every((style) => style.d?.startsWith('M '))).toBe(true)
    expect(routeStyles.every((style) => style.stroke === 'rgba(114, 231, 170, 0.62)'))
      .toBe(true)
    expect(routeStyles.every((style) => style.strokeWidth === '1.6px')).toBe(true)
    const runningCell = page.locator('.cell-node-running')
    await runningCell.waitFor({ state: 'visible' })
    expect(await runningCell.evaluate((element) =>
      window.getComputedStyle(element).animationName)).toBe('none')
    expect(await runningCell.getAttribute('aria-busy')).toBe('true')
    expect(await runningCell.locator('.cell-state-shimmer > span').count()).toBe(0)
    expect(await runningCell.locator('.cell-target-connection-count').textContent()).toBe('2')
    const selector = page.getByLabel('Chat model')
    expect(await selector.locator('option').allTextContents()).toEqual(['Sol', 'Terra'])
    await selector.selectOption('gpt-5.6-terra')
    expect(await page.evaluate(() => window.localStorage.getItem('videobook.chat-model')))
      .toBe('gpt-5.6-terra')

    await input.fill('Show me every asset in this book')
    await wait(700)
    observedCalls.length = 0
    await page.getByLabel('Send command').click()
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="mcp-activity"]')?.textContent
        ?.includes('Routing chat'))
    const shell = page.locator('.command-line-shell')
    expect(await shell.getAttribute('aria-busy')).toBe('true')
    expect(await shell.evaluate((element) => window.getComputedStyle(element).animationName))
      .toContain('command-transmit-pulse')
    const screenshotPath = process.env.VIDEOBOOK_E2E_SCREENSHOT
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true })

    await expect.poll(() => observedCalls.find((call) => call.name === 'chat'), {
      timeout: 20_000,
    }).toBeTruthy()
    const chatCall = observedCalls.find((call) => call.name === 'chat')
    expect(chatCall?.arguments.model).toBe('gpt-5.6-terra')
    expect(observedCalls.some((call) => call.name === 'plan_chat_command')).toBe(false)
    const errorResult = page.locator('.command-result-error')
    await errorResult.waitFor({ state: 'visible' })
    expect(await errorResult.textContent()).toContain('OPENAI_API_KEY')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await input.focus()
    await page.locator('[data-testid="mcp-activity"]').waitFor({ state: 'visible' })
    expect(await shell.evaluate((element) => window.getComputedStyle(element).animationName))
      .toBe('none')
  }, 60_000)

  it('reviews cell-level cloud generation before starting the run', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)
    const reviewCell = page.locator('.cell-node.cell-kind-generate_image').filter({
      hasText: '@b3',
    })
    const generate = reviewCell.getByRole('button', { name: 'Gen' })
    await expect.poll(async () => await generate.isEnabled()).toBe(true)

    observedCalls.length = 0
    await generate.click()
    const review = page.getByLabel('Command plan review')
    await review.waitFor({ state: 'visible' })
    await expect.poll(() => observedCalls.some((call) =>
      call.name === 'plan_notebook_generation')).toBe(true)
    expect(observedCalls.some((call) => call.name === 'run_notebook_cell')).toBe(false)
    await expect.poll(async () => await input.inputValue()).toBe('/apply')

    await input.press('Escape')
    await review.waitFor({ state: 'hidden' })
    expect(observedCalls.some((call) => call.name === 'run_notebook_cell')).toBe(false)
    await expect.poll(async () => await input.inputValue()).toBe('')
    expect(await input.evaluate((element) => document.activeElement === element)).toBe(true)

    observedCalls.length = 0
    await generate.click()
    await review.waitFor({ state: 'visible' })
    await expect.poll(() => observedCalls.some((call) =>
      call.name === 'plan_notebook_generation')).toBe(true)
    expect(observedCalls.some((call) => call.name === 'run_notebook_cell')).toBe(false)
    await page.evaluate(() => window.localStorage.setItem(
      'videobook.cloud-generation-consent',
      'accepted',
    ))
    await review.getByRole('button', { name: 'Apply' }).click()
    await expect.poll(() => observedCalls.some((call) =>
      call.name === 'run_notebook_cell'), {
      timeout: 20_000,
    }).toBe(true)
    const runCall = observedCalls.find((call) => call.name === 'run_notebook_cell')
    expect(runCall?.arguments.cell_id).toBe(reviewGenerationCellId)
  }, 60_000)
})
