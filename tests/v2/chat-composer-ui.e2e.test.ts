import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, ConsoleMessage, Page, Route } from 'playwright'
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

function notebookCellNode(page: Page, cellId: string) {
  return page.locator(
    `.notebook-flow .react-flow__node[data-id="${cellId}"] .cell-node`,
  )
}

async function dragNotebookConnection(
  page: Page,
  sourceCellId: string,
  targetCellId: string,
): Promise<void> {
  const source = page.locator(
    `.notebook-flow .react-flow__node[data-id="${sourceCellId}"] .cell-connect-handle`,
  )
  const target = page.locator(
    `.notebook-flow .react-flow__node[data-id="${targetCellId}"] .cell-target-handle`,
  ).first()
  await source.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) {
    throw new Error('Could not measure notebook connection handles')
  }
  const sourcePoint = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  }
  const targetPoint = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  }
  await page.mouse.move(sourcePoint.x, sourcePoint.y)
  await page.mouse.down()
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 })
  await page.mouse.up()
}

describe('chat composer browser flow', () => {
  let rootDir = ''
  let mcpProcess: StartedProcess | undefined
  let viteProcess: StartedProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let appUrl = ''
  let mcpOrigin = ''
  let bookId = ''
  let notebookId = ''
  let videoCellId = ''
  let imageCellId = ''
  let generationCellId = ''
  let outputVideoCellId = ''
  let reviewGenerationCellId = ''
  let fullscreenImageCellId = ''
  let fullscreenImageMediaUrl = ''
  const observedCalls: ToolCall[] = []
  let delayedBootstrap = false
  let mockedChatActionPlan: {
    prompt: string
    value: Record<string, unknown>
  } | null = null

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-chat-ui-e2e-'))
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    mcpOrigin = `http://127.0.0.1:${mcpPort}`
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
    await client.callTool({ name: 'create_book', arguments: { name: 'chat-ui-e2e' } })
    const booksValue = resultValue(await client.callTool({
      name: 'list_books',
      arguments: { sort: 'newest' },
    }))
    const book = (Array.isArray(booksValue) ? booksValue : [])
      .map(record)
      .find((entry) => entry?.name === 'chat-ui-e2e')
    bookId = typeof book?.bookId === 'string' ? book.bookId : ''
    if (!bookId) throw new Error('Could not create browser fixture book')
    const notebooksValue = resultValue(await client.callTool({
      name: 'list_notebooks',
      arguments: { book_id: bookId },
    }))
    const notebook = (Array.isArray(notebooksValue) ? notebooksValue : [])
      .map(record)
      .find(Boolean)
    notebookId = typeof notebook?.id === 'string' ? notebook.id : ''
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
    videoCellId = await createCell({
      type: 'video',
      label: 'vid-source-one',
      slot: { row: 0, column: 0 },
    })
    imageCellId = await createCell({
      type: 'image',
      label: 'img-source-two',
      slot: { row: 0, column: 2 },
    })
    generationCellId = await createCell({
      type: 'generate_video',
      label: 'generate-video-target',
      slot: { row: 1, column: 0 },
      provider: 'kie',
      model: 'Seedance2MiniInputSchema',
      operation: 'image_to_video',
      tool: 'generate_kie_seedance_2_0_mini_video',
      inputs: {
        state: 'running',
        generationSettings: {
          duration: '10',
          resolution: '720p',
          aspect_ratio: '9:16',
        },
      },
    })
    const generatedNotebook = record(resultValue(await client.callTool({
      name: 'get_notebook',
      arguments: { book_id: bookId, notebook_id: notebookId },
    })))
    const outputVideoCell = (Array.isArray(generatedNotebook?.cells)
      ? generatedNotebook.cells
      : [])
      .map(record)
      .find((cell) =>
        record(cell?.inputs)?.producerCellId === generationCellId)
    outputVideoCellId = typeof outputVideoCell?.id === 'string'
      ? outputVideoCell.id
      : ''
    if (!outputVideoCellId) {
      throw new Error('Could not create browser fixture video output cell')
    }
    reviewGenerationCellId = await createCell({
      type: 'generate_image',
      label: 'generate-image-review',
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
    const uploadedImage = record(resultValue(await client.callTool({
      name: 'upload_file',
      arguments: {
        book_id: bookId,
        filename: 'fullscreen-generation.png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      },
    })))
    const uploadedImageId = typeof uploadedImage?.assetId === 'string'
      ? uploadedImage.assetId
      : ''
    const assetsValue = record(resultValue(await client.callTool({
      name: 'list_assets',
      arguments: { book_id: bookId, sort: 'newest' },
    })))
    const uploadedImageAsset = (Array.isArray(assetsValue?.assets) ? assetsValue.assets : [])
      .map(record)
      .find((asset) => asset?.id === uploadedImageId)
    const uploadedImageArtifactId = typeof uploadedImageAsset?.artifact_id === 'string'
      ? uploadedImageAsset.artifact_id
      : ''
    fullscreenImageMediaUrl = typeof uploadedImageAsset?.media_url === 'string'
      ? uploadedImageAsset.media_url
      : ''
    if (!uploadedImageArtifactId || !fullscreenImageMediaUrl) {
      throw new Error('Could not create fullscreen image fixture asset')
    }
    fullscreenImageCellId = await createCell({
      type: 'generate_image',
      label: 'generate-image-fullscreen',
      slot: { row: 2, column: 2 },
      prompt: 'A fullscreen image fixture',
      output_artifact_id: uploadedImageArtifactId,
    })
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
      const body = await requestBody(route)
      const calls = toolCalls(body)
      observedCalls.push(...calls)
      const mockedCall = mockedChatActionPlan && calls.find((call) =>
        call.name === 'chat'
        && call.arguments.prompt === mockedChatActionPlan?.prompt)
      if (mockedCall && mockedChatActionPlan) {
        const envelopes = Array.isArray(body) ? body : [body]
        const response = envelopes.flatMap((entry) => {
          const envelope = record(entry)
          const params = record(envelope?.params)
          const args = record(params?.arguments)
          if (
            envelope?.method !== 'tools/call'
            || params?.name !== 'chat'
            || args?.prompt !== mockedChatActionPlan?.prompt
            || (typeof envelope.id !== 'number' && typeof envelope.id !== 'string')
          ) return []
          return [{
            jsonrpc: '2.0',
            id: envelope.id,
            result: {
              resultType: 'complete',
              content: [{
                type: 'text',
                text: JSON.stringify(mockedChatActionPlan.value),
              }],
              isError: false,
            },
          }]
        })
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(Array.isArray(body) ? response : response[0]),
        })
        return
      }
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

  it('keeps canvas controls clear and adapts the inspector without a seam', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const topbar = page.locator('.topbar')
    const brand = page.locator('.brand-project')
    const navigation = page.getByLabel('Workspace navigation')
    const toolbar = page.getByLabel('Notebook canvas controls')
    const firstCell = notebookCellNode(page, videoCellId)
    await toolbar.waitFor({ state: 'visible' })
    await firstCell.waitFor({ state: 'visible' })
    const topbarBox = await topbar.boundingBox()
    const brandBox = await brand.boundingBox()
    const navigationBox = await navigation.boundingBox()
    const toolbarBox = await toolbar.boundingBox()
    const firstCellBox = await firstCell.boundingBox()
    if (
      !topbarBox
      || !brandBox
      || !navigationBox
      || !toolbarBox
      || !firstCellBox
    ) {
      throw new Error('Could not measure notebook layout')
    }
    expect(toolbarBox.x).toBeGreaterThanOrEqual(brandBox.x + brandBox.width)
    expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(navigationBox.x)
    expect(Math.abs(
      toolbarBox.y + toolbarBox.height / 2
      - (topbarBox.y + topbarBox.height / 2),
    )).toBeLessThan(1)
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

    const detailCell = notebookCellNode(page, reviewGenerationCellId)
    await detailCell.click()
    await page.locator('.inspector-cell-title').waitFor({ state: 'visible' })
    await wait(250)
    const detailInspectorBox = await page.locator('.inspector').boundingBox()
    const scrollBox = await page.locator('.notebook-horizontal-scroll').boundingBox()
    if (!detailInspectorBox || !scrollBox) {
      throw new Error('Could not measure selected-cell inspector layout')
    }
    expect(detailInspectorBox.width).toBeGreaterThanOrEqual(380)
    expect(detailInspectorBox.width).toBeLessThanOrEqual(440)
    expect(Math.abs(scrollBox.x + scrollBox.width - detailInspectorBox.x))
      .toBeLessThanOrEqual(1)
  }, 60_000)

  it('renders edges whose target handles are added after mount', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const warnings: string[] = []
    const onConsole = (message: ConsoleMessage) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        warnings.push(message.text())
      }
    }
    page.on('console', onConsole)
    const client = new Client(
      { name: 'videobook-dynamic-handles-e2e', version: '1.0.0' },
      {
        capabilities: {},
        supportedProtocolVersions: ['2026-07-28'],
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    )
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp`)))
    const dynamicCellIds: string[] = []
    try {
      const createCell = async (cell: Record<string, unknown>): Promise<string> => {
        const value = record(resultValue(await client.callTool({
          name: 'create_notebook_cell',
          arguments: { book_id: bookId, notebook_id: notebookId, cell },
        })))
        const id = typeof value?.id === 'string' ? value.id : ''
        if (!id) throw new Error('Could not create dynamic handle fixture cell')
        return id
      }
      const refreshNotebook = async (): Promise<void> => {
        observedCalls.length = 0
        await page.getByLabel('Refresh books').click()
        await expect.poll(() => observedCalls.some((call) => call.name === 'list_books'))
          .toBe(true)
        await expect.poll(async () => await input.isEnabled()).toBe(true)
      }
      const connect = async (
        sourceCellId: string,
        targetCellId: string,
        targetInput: string,
      ): Promise<string> => {
        const value = record(resultValue(await client.callTool({
          name: 'connect_notebook_cells',
          arguments: {
            book_id: bookId,
            notebook_id: notebookId,
            source_cell_id: sourceCellId,
            target_cell_id: targetCellId,
            target_input: targetInput,
          },
        })))
        const id = typeof value?.id === 'string' ? value.id : ''
        if (!id) throw new Error('Could not create dynamic handle fixture edge')
        return id
      }
      const assertEdge = async (edgeId: string): Promise<void> => {
        const path = page.locator(
          `.notebook-flow .react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`,
        )
        await expect.poll(async () => await path.count()).toBe(1)
        expect(await path.getAttribute('d')).toMatch(/^M /)
      }

      const secondImageCellId = await createCell({
        type: 'image',
        label: 'img-source-dynamic',
        slot: { row: 0, column: 4 },
      })
      dynamicCellIds.push(secondImageCellId)
      const imageTargetCellId = await createCell({
        type: 'generate_image',
        label: 'generate-image-dynamic-target',
        slot: { row: 1, column: 1 },
        prompt: 'Dynamic image target',
      })
      dynamicCellIds.push(imageTargetCellId)
      await refreshNotebook()
      const imageTargetNode = page.locator(
        `.notebook-flow .react-flow__node[data-id="${imageTargetCellId}"]`,
      )
      await imageTargetNode.waitFor({ state: 'visible' })
      expect(await imageTargetNode.locator('.cell-target-handle').count()).toBe(1)

      observedCalls.length = 0
      await dragNotebookConnection(page, videoCellId, imageTargetCellId)
      await expect.poll(() => observedCalls.some((call) =>
        call.name === 'connect_notebook_cells'
        && call.arguments.source_cell_id === videoCellId
        && call.arguments.target_cell_id === imageTargetCellId
        && call.arguments.target_input === 'video')).toBe(true)
      await expect.poll(async () => await input.isEnabled()).toBe(true)

      observedCalls.length = 0
      await dragNotebookConnection(page, imageCellId, imageTargetCellId)
      await expect.poll(() => observedCalls.some((call) =>
        call.name === 'connect_notebook_cells'
        && call.arguments.source_cell_id === imageCellId
        && call.arguments.target_cell_id === imageTargetCellId
        && call.arguments.target_input === 'image')).toBe(true)
      await expect.poll(async () => await input.isEnabled()).toBe(true)
      await expect.poll(async () =>
        await imageTargetNode.locator('.cell-target-handle').count()).toBe(2)
      expect(await imageTargetNode.locator('.cell-target-connection-count').count()).toBe(0)

      const connectedNotebook = record(resultValue(await client.callTool({
        name: 'get_notebook',
        arguments: { book_id: bookId, notebook_id: notebookId },
      })))
      const imageTargetEdges = (Array.isArray(connectedNotebook?.edges)
        ? connectedNotebook.edges
        : []).map(record).filter((edge) => edge?.target === imageTargetCellId)
      expect(imageTargetEdges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: videoCellId, targetInput: 'video' }),
        expect.objectContaining({ source: imageCellId, targetInput: 'image' }),
      ]))
      for (const edge of imageTargetEdges) {
        if (typeof edge?.id === 'string') await assertEdge(edge.id)
      }

      const videoTargetCellId = await createCell({
        type: 'generate_video',
        label: 'generate-video-dynamic-target',
        slot: { row: 2, column: 4 },
        provider: 'kie',
        model: 'Seedance2MiniInputSchema',
        operation: 'image_to_video',
        tool: 'generate_kie_seedance_2_0_mini_video',
      })
      dynamicCellIds.push(videoTargetCellId)
      await refreshNotebook()
      const videoTargetNode = page.locator(
        `.notebook-flow .react-flow__node[data-id="${videoTargetCellId}"]`,
      )
      await videoTargetNode.waitFor({ state: 'visible' })
      expect(await videoTargetNode.locator('.cell-target-handle').count()).toBe(1)

      const firstVideoEdgeId = await connect(imageCellId, videoTargetCellId, 'image')
      await refreshNotebook()
      await assertEdge(firstVideoEdgeId)
      const secondVideoEdgeId = await connect(secondImageCellId, videoTargetCellId, 'image_2')
      await refreshNotebook()
      expect(await videoTargetNode.locator('.cell-target-handle').count()).toBe(2)
      for (const edgeId of [firstVideoEdgeId, secondVideoEdgeId]) await assertEdge(edgeId)

      const notebookValue = record(resultValue(await client.callTool({
        name: 'get_notebook',
        arguments: { book_id: bookId, notebook_id: notebookId },
      })))
      const documentEdgeIds = (Array.isArray(notebookValue?.edges) ? notebookValue.edges : [])
        .map(record)
        .flatMap((edge) => typeof edge?.id === 'string' ? [edge.id] : [])
      const routePaths = page.locator('.notebook-flow .workflow-edge .react-flow__edge-path')
      await expect.poll(async () => await routePaths.count()).toBe(documentEdgeIds.length)
      for (const edgeId of documentEdgeIds) await assertEdge(edgeId)
      expect(warnings.filter((message) => /handle id|couldn't create edge/i.test(message)))
        .toEqual([])
    } finally {
      page.off('console', onConsole)
      for (const cellId of dynamicCellIds.reverse()) {
        resultValue(await client.callTool({
          name: 'delete_notebook_cell',
          arguments: { book_id: bookId, notebook_id: notebookId, cell_id: cellId },
        }))
      }
      await client.close()
    }
  }, 60_000)

  it('opens generation output fullscreen and restores the trigger focus', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)
    await page.getByLabel('Open inspector').click()
    const fullscreenNode = page.locator(
      `.notebook-flow .react-flow__node[data-id="${fullscreenImageCellId}"]`,
    )
    await fullscreenNode.click()
    const trigger = page.getByLabel('Open @c3 fullscreen')
    await trigger.waitFor({ state: 'visible' })
    await wait(250)
    const triggerBox = await trigger.boundingBox()
    if (!triggerBox) throw new Error('Could not measure fullscreen trigger')
    const previewBox = await trigger.locator('..').boundingBox()
    if (!previewBox) throw new Error('Could not measure fullscreen preview')
    expect(Math.abs(triggerBox.width - previewBox.width)).toBeLessThanOrEqual(2)
    expect(triggerBox.height).toBeGreaterThanOrEqual(44)
    const triggerPoint = {
      x: previewBox.x + previewBox.width - 10,
      y: triggerBox.y + triggerBox.height / 2,
    }
    expect(await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'), {
      x: triggerPoint.x,
      y: triggerPoint.y,
    })).toBe('Open @c3 fullscreen')

    await page.mouse.click(triggerPoint.x, triggerPoint.y)
    const dialog = page.getByRole('dialog', { name: 'Fullscreen preview for @c3' })
    await dialog.waitFor({ state: 'visible' })
    const image = dialog.locator('img')
    expect(await image.getAttribute('src')).toContain(fullscreenImageMediaUrl)
    await expect.poll(async () => await image.evaluate((element) => ({
      complete: element.complete,
      naturalWidth: element.naturalWidth,
    }))).toEqual({ complete: true, naturalWidth: 1 })
    const close = page.getByLabel('Close fullscreen preview')
    expect(await close.evaluate((element) => document.activeElement === element)).toBe(true)

    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true)

    await trigger.click()
    await dialog.waitFor({ state: 'visible' })
    await close.click()
    await dialog.waitFor({ state: 'hidden' })
    expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true)
  }, 60_000)

  it('turns every open notebook square into a media file dropzone', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#48b26f"/></svg>',
      ], 'grid-drop.svg', { type: 'image/svg+xml' }))
      return transfer
    })
    const squares = page.locator('.notebook-grid-square')
    const cells = page.locator('.cell-node')
    const targetSquare = squares.filter({ hasText: /^@a2$/ })

    try {
      await page.dispatchEvent('.app-shell', 'dragenter', { dataTransfer })
      await expect.poll(async () =>
        await page.locator('.notebook-grid-square-dropzone').count(),
      ).toBe(await squares.count() - await cells.count())
      expect(await squares.filter({ hasText: /^@a1$/ }).getAttribute('class'))
        .not.toContain('notebook-grid-square-dropzone')

      const targetBox = await targetSquare.boundingBox()
      if (!targetBox) throw new Error('Could not measure the open drop square')
      const dropPoint = {
        x: targetBox.x + targetBox.width / 2,
        y: targetBox.y + targetBox.height / 2,
      }
      await page.dispatchEvent('.notebook-flow', 'dragover', {
        dataTransfer,
        clientX: dropPoint.x,
        clientY: dropPoint.y,
      })
      await expect.poll(async () => await targetSquare.getAttribute('class'))
        .toContain('notebook-grid-square-drop-target')

      observedCalls.length = 0
      await page.dispatchEvent('.notebook-flow', 'drop', {
        dataTransfer,
        clientX: dropPoint.x,
        clientY: dropPoint.y,
      })
      const droppedCell = page.locator('.cell-node').filter({
        has: page.locator('.cell-node-footer strong').filter({ hasText: /^@a2$/ }),
      })
      await droppedCell.waitFor({ state: 'visible', timeout: 30_000 })
      expect(await page.locator('.notebook-grid-square-dropzone').count()).toBe(0)
      expect(observedCalls.some((call) =>
        call.name === 'create_notebook_cell'
        && call.arguments.cell !== null
        && typeof call.arguments.cell === 'object'
        && (call.arguments.cell as Record<string, unknown>).type === 'image'))
        .toBe(true)
      expect(observedCalls.some((call) => call.name === 'set_notebook_media_slot'))
        .toBe(true)
    } finally {
      await dataTransfer.dispose()
    }
  }, 60_000)

  it('keeps cell identity and prompt actions in compact inspector headers', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            sessionStorage.setItem('videobook-test-clipboard', value)
          },
        },
      })
    })
    await page.goto(appUrl, { waitUntil: 'commit' })
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const reopenInspector = page.getByLabel('Open inspector')
    if (await reopenInspector.isVisible()) await reopenInspector.click()
    const generationCell = notebookCellNode(page, generationCellId)
    await generationCell.click()

    const inspector = page.locator('.inspector')
    await inspector.locator('.inspector-cell-address').waitFor({ state: 'visible' })
    expect(await inspector.locator('.inspector-cell-address').textContent()).toBe('@b1')
    // The grid address is the cell handle, so the compact header carries no
    // editable identity field of its own.
    expect(await inspector.locator('header input, header textarea').count()).toBe(0)

    const inputsHeading = inspector.locator('.inspector-input-sources h3')
    const promptHeading = inspector.locator('.inspector-prompt-header h3')
    const headingStyles = async (selector: typeof inputsHeading) => await selector.evaluate(
      (element) => {
        const style = getComputedStyle(element)
        return {
          color: style.color,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing,
          textTransform: style.textTransform,
        }
      },
    )
    expect(await headingStyles(promptHeading)).toEqual(await headingStyles(inputsHeading))

    const promptInput = inspector.getByLabel('Prompt', { exact: true })
    await promptInput.fill('use @a')
    const mentionMenu = page.locator('.bg-background').filter({
      has: page.getByRole('button', { name: /@a1/ }),
    })
    await mentionMenu.waitFor({ state: 'visible' })
    expect(await mentionMenu.getByRole('button').count()).toBeGreaterThan(0)
    await promptInput.fill('use @z13')
    const mentionWarning = inspector.locator('.inspector-prompt-mentions')
    await mentionWarning.waitFor({ state: 'visible' })
    await expect.poll(async () => await mentionWarning.textContent())
      .toContain('@z13')
    expect(await mentionWarning.textContent()).toContain('was not found')

    const prompt = 'Inspector prompt clipboard check'
    await promptInput.fill(prompt)
    await inspector.getByLabel('Copy prompt').click()
    await inspector.getByLabel('Prompt copied').waitFor({ state: 'visible' })
    expect(await page.evaluate(() =>
      sessionStorage.getItem('videobook-test-clipboard'))).toBe(prompt)
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

  it('uses the full routed review width for complete URL details', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    const prompt = 'download the annotated routed review fixture'
    const url = 'https://x.com/BardiGangUpdate/status/1297030012345678901?source=videobook&include=complete'
    mockedChatActionPlan = {
      prompt,
      value: {
        kind: 'chat-action-plan',
        planId: '01900000-0000-7000-8000-000000000101',
        bookId: '01900000-0000-7000-8000-000000000102',
        prompt,
        routedTool: 'download_video',
        tool: 'download_video',
        params: {
          url,
          export_videos: false,
          full: false,
        },
        message: 'Downloading video.',
        summary: 'Downloading video.',
        effect: 'mutation',
        confirmation: {
          required: true,
          reason: 'This request changes the current book',
        },
      },
    }
    try {
      await page.goto(appUrl, { waitUntil: 'commit' })
      const input = page.getByLabel('Videobook command input')
      await input.waitFor({ state: 'visible', timeout: 30_000 })
      await expect.poll(async () => await input.isEnabled()).toBe(true)
      await input.fill(prompt)
      await page.getByLabel('Send command').click()

      const review = page.getByLabel('Chat action review')
      await review.waitFor({ state: 'visible', timeout: 30_000 })
      expect(await review.getByText('This request changes the current book').count()).toBe(0)
      const content = review.locator('.command-plan-content-routed')
      expect(await content.count()).toBe(1)
      const urlSetting = review.locator('.routed-action-setting-wide')
      expect(await urlSetting.locator('dd').textContent()).toBe(url)
      expect(await urlSetting.evaluate((element) =>
        window.getComputedStyle(element).gridColumnEnd)).toBe('-1')
      expect(await urlSetting.locator('dd').evaluate((element) => ({
        overflowWrap: window.getComputedStyle(element).overflowWrap,
        textOverflow: window.getComputedStyle(element).textOverflow,
        whiteSpace: window.getComputedStyle(element).whiteSpace,
      }))).toEqual({
        overflowWrap: 'anywhere',
        textOverflow: 'clip',
        whiteSpace: 'normal',
      })
    } finally {
      mockedChatActionPlan = null
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
    await expect.poll(async () => await routePaths.count()).toBe(3)
    const routeStyles = await routePaths.evaluateAll((paths) => paths.map((path) => ({
      d: path.getAttribute('d'),
      stroke: window.getComputedStyle(path).stroke,
      strokeWidth: window.getComputedStyle(path).strokeWidth,
    })))
    expect(routeStyles).toHaveLength(3)
    expect(routeStyles.every((style) => style.d?.startsWith('M '))).toBe(true)
    expect(routeStyles.every((style) => style.stroke === 'rgba(114, 231, 170, 0.62)'))
      .toBe(true)
    expect(routeStyles.every((style) => style.strokeWidth === '1.6px')).toBe(true)
    const runningCell = notebookCellNode(page, generationCellId)
    await runningCell.waitFor({ state: 'visible' })
    expect(await runningCell.getAttribute('class')).toContain('cell-node-running')
    expect(await runningCell.evaluate((element) =>
      window.getComputedStyle(element).animationName)).toBe('none')
    expect(await runningCell.getAttribute('aria-busy')).toBe('true')
    expect(await runningCell.locator('.cell-state-shimmer > span').count()).toBe(0)
    expect(await runningCell.locator('.cell-target-handle').count()).toBe(2)
    expect(await runningCell.locator('.cell-target-connection-count').count()).toBe(0)
    const selector = page.getByLabel('Chat model')
    expect(await selector.locator('option').allTextContents()).toEqual(['gpt-5.6-sol'])
    expect(await selector.inputValue()).toBe('gpt-5.6-sol')

    // @c3 is the only fixture cell with real media output, so it is the grid
    // address the server-side resolver can rewrite to an artifact id.
    const routedPrompt = 'generate image scene @c3, fluffy kitten standing'
    await input.fill(routedPrompt)
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
    const workingIndicator = page.locator('.command-send-working')
    await workingIndicator.waitFor({ state: 'visible' })
    await wait(220)
    const workingBox = await workingIndicator.boundingBox()
    expect(await workingIndicator.evaluate((element) =>
      window.getComputedStyle(element).animationName)).toBe('command-working-pulse')
    await wait(240)
    expect(await workingIndicator.boundingBox()).toEqual(workingBox)
    const screenshotPath = process.env.VIDEOBOOK_E2E_SCREENSHOT
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true })

    await expect.poll(() => observedCalls.find((call) => call.name === 'chat'), {
      timeout: 20_000,
    }).toBeTruthy()
    const chatCall = observedCalls.find((call) => call.name === 'chat')
    expect(chatCall?.arguments.model).toBe('gpt-5.6-sol')
    expect(chatCall?.arguments.notebook_id).toEqual(expect.any(String))
    expect(chatCall?.arguments.prompt).toBe(routedPrompt)
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
    const reviewCell = notebookCellNode(page, reviewGenerationCellId)
    const reopenInspector = page.getByLabel('Open inspector')
    if (await reopenInspector.isVisible()) await reopenInspector.click()
    await reviewCell.click()
    const generate = page.getByLabel('Primary cell action')
      .getByRole('button', { name: 'Generate' })
    await expect.poll(async () => await generate.isEnabled()).toBe(true)

    observedCalls.length = 0
    await generate.click({ timeout: 10_000 })
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
    await generate.click({ timeout: 10_000 })
    await review.waitFor({ state: 'visible' })
    await expect.poll(() => observedCalls.some((call) =>
      call.name === 'plan_notebook_generation')).toBe(true)
    expect(observedCalls.some((call) => call.name === 'run_notebook_cell')).toBe(false)
    await page.evaluate(() => window.localStorage.setItem(
      'videobook.cloud-generation-consent',
      'accepted',
    ))
    await review.getByRole('button', { name: 'Apply' }).click({ timeout: 10_000 })
    await expect.poll(() => observedCalls.some((call) =>
      call.name === 'run_notebook_cell'), {
      timeout: 20_000,
    }).toBe(true)
    const runCall = observedCalls.find((call) => call.name === 'run_notebook_cell')
    expect(runCall?.arguments.cell_id).toBe(reviewGenerationCellId)
  }, 60_000)

  it('keeps dense generation card headers compact and vertically centered', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const header = notebookCellNode(page, generationCellId)
      .locator('.cell-node-header')
    await header.waitFor({ state: 'visible' })
    const layout = await header.evaluate((element) => {
      const headerRect = element.getBoundingClientRect()
      const type = element.querySelector('.cell-node-type')
      const chips = element.querySelector('.cell-generation-chips')
      if (!(type instanceof HTMLElement) || !(chips instanceof HTMLElement)) {
        throw new Error('Generation header content is missing')
      }
      const typeRect = type.getBoundingClientRect()
      const chipsRect = chips.getBoundingClientRect()
      const label = type.querySelector('.cell-node-type-label')
      if (!(label instanceof HTMLElement)) {
        throw new Error('Generation header label is missing')
      }
      const headerCenter = headerRect.top + headerRect.height / 2
      return {
        accessibleLabel: type.getAttribute('aria-label'),
        chipLabels: [...chips.querySelectorAll('.cell-aspect-ratio')]
          .map((chip) => chip.textContent?.trim()),
        contentGap: chipsRect.left - typeRect.right,
        headerHeight: Number.parseFloat(getComputedStyle(element).height),
        labelClipped: label.scrollWidth > label.clientWidth,
        renderedLabel: type.textContent?.trim(),
        typeCenterOffset: Math.abs(typeRect.top + typeRect.height / 2 - headerCenter),
        chipsCenterOffset: Math.abs(chipsRect.top + chipsRect.height / 2 - headerCenter),
        whiteSpace: getComputedStyle(label).whiteSpace,
      }
    })

    expect(layout).toMatchObject({
      accessibleLabel: 'GEN VIDEO',
      chipLabels: ['10s', '9:16'],
      headerHeight: 38,
      labelClipped: false,
      renderedLabel: 'GEN VID',
      whiteSpace: 'nowrap',
    })
    expect(layout.contentGap).toBeGreaterThanOrEqual(0)
    expect(layout.typeCenterOffset).toBeLessThan(1)
    expect(layout.chipsCenterOffset).toBeLessThan(1)

    const outputMetadata = notebookCellNode(page, outputVideoCellId)
      .locator('.cell-media-chips')
    await outputMetadata.waitFor({ state: 'visible' })
    expect(await outputMetadata.locator('.cell-aspect-ratio').allTextContents())
      .toEqual(['0:10', '9:16'])

    const relaxedType = notebookCellNode(page, reviewGenerationCellId)
      .locator('.cell-node-type')
    expect((await relaxedType.textContent())?.trim()).toBe('GEN IMAGE')
  }, 60_000)

  it('marquee-selects multiple cells and confirms before deleting the set', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const firstCell = notebookCellNode(page, videoCellId)
    const secondCell = notebookCellNode(page, generationCellId)
    await firstCell.waitFor({ state: 'visible' })
    await secondCell.waitFor({ state: 'visible' })
    const pane = page.locator('.notebook-flow .react-flow__pane')
    const firstCellBox = await firstCell.boundingBox()
    const secondCellBox = await secondCell.boundingBox()
    const paneBox = await pane.boundingBox()
    if (!firstCellBox || !secondCellBox || !paneBox) {
      throw new Error('Could not measure notebook selection targets')
    }
    const selectionStart = {
      x: Math.min(
        paneBox.x + paneBox.width - 2,
        Math.max(
          firstCellBox.x + firstCellBox.width,
          secondCellBox.x + secondCellBox.width,
        ) + 8,
      ),
      y: Math.max(paneBox.y + 2, Math.min(firstCellBox.y, secondCellBox.y) - 8),
    }
    const selectionEnd = {
      x: Math.max(paneBox.x + 2, Math.min(firstCellBox.x, secondCellBox.x) - 8),
      y: Math.min(
        paneBox.y + paneBox.height - 2,
        Math.max(
          firstCellBox.y + firstCellBox.height,
          secondCellBox.y + secondCellBox.height,
        ) + 8,
      ),
    }
    const selectionStartTarget = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y)
      return {
        className: element?.getAttribute('class') ?? '',
        tagName: element?.tagName ?? '',
      }
    }, selectionStart)
    expect(selectionStartTarget.className).toContain('react-flow__pane')
    await page.mouse.move(selectionStart.x, selectionStart.y)
    await page.mouse.down()
    const marquee = page.locator('.notebook-flow .react-flow__selection')
    try {
      await page.mouse.move(selectionEnd.x, selectionEnd.y, { steps: 8 })
      await marquee.waitFor({ state: 'visible' })
      expect(await marquee.evaluate((element) => {
        const style = window.getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          borderStyle: style.borderStyle,
        }
      })).toEqual({
        backgroundColor: 'rgba(79, 183, 125, 0.12)',
        borderStyle: 'dashed',
      })
    } finally {
      await page.mouse.up()
    }
    await marquee.waitFor({ state: 'hidden' })

    const actions = page.getByLabel('Notebook selection actions')
    await actions.waitFor({ state: 'visible' })
    await expect.poll(async () => await actions.textContent()).toContain('2 selected')
    expect(await actions.textContent()).toContain('@a1 active')
    expect(await firstCell.getAttribute('data-selection')).toBe('primary')
    expect(await secondCell.getAttribute('data-selection')).toBe('selected')

    await secondCell.click({ modifiers: ['Shift'] })
    await expect.poll(async () => await actions.textContent()).toContain('1 selected')
    expect(await firstCell.getAttribute('data-selection')).toBe('primary')
    expect(await secondCell.getAttribute('data-selection')).toBeNull()
    await secondCell.click({ modifiers: ['Shift'] })
    await expect.poll(async () => await actions.textContent()).toContain('2 selected')

    observedCalls.length = 0
    const deleteSelection = page.getByLabel('Delete 2 selected cells')
    const cancelledDialog = new Promise<string>((resolve) => {
      page!.once('dialog', async (dialog) => {
        resolve(dialog.message())
        await dialog.dismiss()
      })
    })
    await deleteSelection.click()
    const cancelMessage = await cancelledDialog
    expect(cancelMessage).toContain('Delete 2 selected cells?')
    expect(cancelMessage).toContain('@a1, @b1')
    expect(observedCalls.some((call) => call.name === 'delete_notebook_cell')).toBe(false)
    expect(await firstCell.count()).toBe(1)
    expect(await secondCell.count()).toBe(1)

    const acceptedDialog = new Promise<string>((resolve) => {
      page!.once('dialog', async (dialog) => {
        resolve(dialog.message())
        await dialog.accept()
      })
    })
    await deleteSelection.click()
    expect(await acceptedDialog).toContain('@a1, @b1')
    await firstCell.waitFor({ state: 'hidden' })
    await secondCell.waitFor({ state: 'hidden' })
    await actions.waitFor({ state: 'hidden' })
    const deleteCalls = observedCalls.filter((call) =>
      call.name === 'delete_notebook_cell')
    expect(deleteCalls).toHaveLength(2)
  }, 60_000)
})
