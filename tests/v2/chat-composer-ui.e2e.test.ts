import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, ConsoleMessage, Page, Route } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG } from '../../server/src/ffmpeg.js'

const execFileAsync = promisify(execFile)

interface StartedProcess {
  child: ChildProcess
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
  let videoArtifactId = ''
  let imageCellId = ''
  let generationCellId = ''
  let outputVideoCellId = ''
  let reviewGenerationCellId = ''
  let directVideoGenerationCellId = ''
  let fullscreenImageGenerationCellId = ''
  let fullscreenImageCellId = ''
  let fullscreenImageArtifactId = ''
  let fullscreenImageObjectHash = ''
  let fullscreenImageMediaUrl = ''
  const observedCalls: ToolCall[] = []
  let delayedBootstrap = false
  let delayChatResponses = false
  let appReady = false
  let notebookDirty = false
  let mockedChatActionPlan: {
    prompt: string
    value: Record<string, unknown>
  } | null = null
  let mockedWatermarkApply = false
  let mockedFullscreenSubjectEditor = false
  let mockedSubjectEditCompletions = 0
  let mockedSubjectEditDelays: number[] = []

  beforeEach(() => {
    mockedFullscreenSubjectEditor = false
    mockedSubjectEditCompletions = 0
    mockedSubjectEditDelays = []
    delayChatResponses = false
    mockedWatermarkApply = false
  })

  afterEach(async () => {
    mockedFullscreenSubjectEditor = false
    mockedSubjectEditDelays = []
    mockedWatermarkApply = false
    await page?.setViewportSize({ width: 1440, height: 1000 })
  })

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
    const splitSourcePath = join(rootDir, 'split-source.mp4')
    await execFileAsync(FFMPEG, [
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc2=s=96x64:r=24:d=3',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      splitSourcePath,
    ])
    const uploadedVideo = record(resultValue(await client.callTool({
      name: 'upload_file',
      arguments: {
        book_id: bookId,
        filename: 'split-source.mp4',
        data: (await readFile(splitSourcePath)).toString('base64'),
      },
    })))
    const uploadedVideoId = typeof uploadedVideo?.assetId === 'string'
      ? uploadedVideo.assetId
      : ''
    const videoAssetsValue = record(resultValue(await client.callTool({
      name: 'list_assets',
      arguments: { book_id: bookId, sort: 'newest' },
    })))
    const uploadedVideoAsset = (Array.isArray(videoAssetsValue?.assets)
      ? videoAssetsValue.assets
      : [])
      .map(record)
      .find((asset) => asset?.id === uploadedVideoId)
    const uploadedVideoArtifactId = typeof uploadedVideoAsset?.artifact_id === 'string'
      ? uploadedVideoAsset.artifact_id
      : ''
    if (!uploadedVideoArtifactId || typeof uploadedVideoAsset?.media_url !== 'string') {
      throw new Error('Could not create split video fixture asset')
    }
    videoArtifactId = uploadedVideoArtifactId
    videoCellId = await createCell({
      type: 'video',
      label: 'vid-source-one',
      slot: { row: 0, column: 0 },
      output_artifact_id: uploadedVideoArtifactId,
      inputs: { durationSeconds: 3 },
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
      tool: 'generate_kie_seedance_2_5_video',
      inputs: {
        state: 'running',
        generationSettings: {
          duration: '10',
          resolution: '720p',
          aspect_ratio: '9:16',
        },
      },
    })
    outputVideoCellId = await createCell({
      type: 'video',
      label: 'generate-video-output',
      slot: { row: 2, column: 0 },
      inputs: {
        mediaRole: 'generate-video-output',
        producerCellId: generationCellId,
      },
    })
    resultValue(await client.callTool({
      name: 'connect_notebook_cells',
      arguments: {
        book_id: bookId,
        notebook_id: notebookId,
        source_cell_id: generationCellId,
        target_cell_id: outputVideoCellId,
        target_input: 'media',
      },
    }))
    reviewGenerationCellId = await createCell({
      type: 'generate_image',
      label: 'generate-image-review',
      slot: { row: 1, column: 2 },
      prompt: 'A moonlit garden ready for review',
    })
    directVideoGenerationCellId = await createCell({
      type: 'generate_video',
      label: 'generate-video-direct',
      slot: { row: 3, column: 1 },
      prompt: 'A moonlit garden moving in a light breeze',
      provider: 'kie',
      model: 'Seedance2MiniInputSchema',
      operation: 'text_to_video',
      tool: 'generate_kie_seedance_2_5_video',
      inputs: {
        generationSettings: {
          duration: '5',
          resolution: '720p',
          aspect_ratio: '16:9',
        },
      },
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
    fullscreenImageArtifactId = typeof uploadedImageAsset?.artifact_id === 'string'
      ? uploadedImageAsset.artifact_id
      : ''
    fullscreenImageObjectHash = typeof uploadedImageAsset?.object_hash === 'string'
      ? uploadedImageAsset.object_hash
      : ''
    fullscreenImageMediaUrl = typeof uploadedImageAsset?.media_url === 'string'
      ? uploadedImageAsset.media_url
      : ''
    if (!fullscreenImageArtifactId || !fullscreenImageObjectHash || !fullscreenImageMediaUrl) {
      throw new Error('Could not create fullscreen image fixture asset')
    }
    fullscreenImageGenerationCellId = await createCell({
      type: 'generate_image',
      label: 'generate-image-fullscreen',
      slot: { row: 2, column: 1 },
      prompt: 'A fullscreen image fixture',
      provider: 'google-flow',
      model: 'nano-banana-pro',
      operation: 'text_to_image',
      tool: 'generate_google_flow_nano_banana_pro_image',
    })
    fullscreenImageCellId = await createCell({
      type: 'image',
      label: 'generate-image-fullscreen image',
      slot: { row: 2, column: 2 },
      prompt: 'A fullscreen image fixture',
      provider: 'google-flow',
      model: 'nano-banana-pro',
      tool: 'generate_google_flow_nano_banana_pro_image',
      output_artifact_id: fullscreenImageArtifactId,
      inputs: {
        mediaRole: 'generate-image-output',
        producerCellId: fullscreenImageGenerationCellId,
        state: 'completed',
      },
    })
    resultValue(await client.callTool({
      name: 'connect_notebook_cells',
      arguments: {
        book_id: bookId,
        notebook_id: notebookId,
        source_cell_id: fullscreenImageGenerationCellId,
        target_cell_id: fullscreenImageCellId,
        target_input: 'media',
      },
    }))
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
      const mockedSubjectCall = mockedFullscreenSubjectEditor && calls.length === 1
        ? calls[0]
        : null
      if (
        mockedSubjectCall?.name === 'get_image_subject_map'
        || mockedSubjectCall?.name === 'edit_image_subjects'
      ) {
        const envelopes = Array.isArray(body) ? body : [body]
        const envelope = record(envelopes[0])
        if (typeof envelope?.id !== 'number' && typeof envelope?.id !== 'string') {
          throw new Error('Mocked subject editor call is missing an MCP request id')
        }
        const value = mockedSubjectCall.name === 'get_image_subject_map'
          ? {
              status: 'ready',
              artifact_id: fullscreenImageArtifactId,
              object_hash: fullscreenImageObjectHash,
              width: 1,
              height: 1,
              base_url: fullscreenImageMediaUrl,
              subjects: [{
                id: 'person-foreground',
                label: 'Foreground person',
                description: 'Person nearest the camera',
                normalized_box: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
                layer_url: fullscreenImageMediaUrl,
                thumbnail_url: fullscreenImageMediaUrl,
                z_index: 1,
                capabilities: { remove: true, exact_edit: false },
              }],
            }
          : { status: 'queued', job_id: 'image-edit-job' }
        if (mockedSubjectCall.name === 'edit_image_subjects') {
          await wait(mockedSubjectEditDelays.shift() ?? 400)
          mockedSubjectEditCompletions += 1
        }
        const response = {
          jsonrpc: '2.0',
          id: envelope.id,
          result: {
            resultType: 'complete',
            content: [{ type: 'text', text: JSON.stringify(value) }],
            isError: false,
          },
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(Array.isArray(body) ? [response] : response),
        })
        return
      }
      const mockedWatermarkCall = mockedWatermarkApply
        ? calls.find((call) => call.name === 'apply_watermark')
        : null
      if (mockedWatermarkCall) {
        const envelopes = Array.isArray(body) ? body : [body]
        const response = envelopes.flatMap((entry) => {
          const envelope = record(entry)
          const params = record(envelope?.params)
          if (
            envelope?.method !== 'tools/call'
            || params?.name !== 'apply_watermark'
            || (typeof envelope.id !== 'number' && typeof envelope.id !== 'string')
          ) return []
          return [{
            jsonrpc: '2.0',
            id: envelope.id,
            result: {
              resultType: 'complete',
              content: [{
                type: 'text',
                text: JSON.stringify({
                  placement_source: 'manual',
                  position: mockedWatermarkCall.arguments.position,
                }),
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
      const mockedCall = mockedChatActionPlan && calls.find((call) =>
        call.name === 'chat'
        && call.arguments.prompt === mockedChatActionPlan?.prompt)
      const chatPlan = mockedChatActionPlan
      if (mockedCall && chatPlan) {
        const envelopes = Array.isArray(body) ? body : [body]
        const response = envelopes.flatMap((entry) => {
          const envelope = record(entry)
          const params = record(envelope?.params)
          const args = record(params?.arguments)
          if (
            envelope?.method !== 'tools/call'
            || params?.name !== 'chat'
            || args?.prompt !== chatPlan.prompt
            || (typeof envelope.id !== 'number' && typeof envelope.id !== 'string')
          ) return []
          return [{
            jsonrpc: '2.0',
            id: envelope.id,
            result: {
              resultType: 'complete',
              content: [{
                type: 'text',
                text: JSON.stringify(chatPlan.value),
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
      if (delayChatResponses && calls.some((call) => call.name === 'chat')) {
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

  async function openApp(options: { cold?: boolean } = {}): Promise<Page> {
    if (!page) throw new Error('Browser page was not initialized')
    const remount = options.cold || !appReady || notebookDirty
    if (remount) {
      delayedBootstrap = appReady && !options.cold
      await page.goto(appUrl, { waitUntil: 'commit' })
      appReady = true
      notebookDirty = false
      if (options.cold) return page
    } else {
      await page.keyboard.press('Escape').catch(() => undefined)
      await page.keyboard.press('Escape').catch(() => undefined)
      const closer = page.getByLabel('Close fullscreen preview')
      if (await closer.count()) await closer.click().catch(() => undefined)
      const input = page.getByLabel('Videobook command input')
      if (await input.count()) await input.fill('').catch(() => undefined)
    }
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)
    return page
  }

  it('cold-starts the MCP-backed app and keeps canvas controls clear', async () => {
    const page = await openApp({ cold: true })

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
    const addCellSearch = page.getByLabel('Search cell types')
    await addCellSearch.waitFor({ state: 'visible' })
    await expect.poll(async () =>
      await addCellSearch.evaluate((element) => document.activeElement === element),
    ).toBe(true)
    await addCellSearch.fill('split')
    const addCellMenu = page.locator('.canvas-add-menu')
    await addCellMenu.getByRole('button', { name: 'Split video' })
      .waitFor({ state: 'visible' })
    expect(await addCellMenu.getByRole('button', { name: 'Audio', exact: true }).count())
      .toBe(0)
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
    await openApp()
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
        if (!page) throw new Error('Browser page was not initialized')
        const refresh = page.getByLabel('Refresh books')
        observedCalls.length = 0
        await refresh.click()
        await expect.poll(() => observedCalls.some((call) => call.name === 'list_books'))
          .toBe(true)
        await expect.poll(async () => await refresh.isEnabled(), {
          timeout: 30_000,
        }).toBe(true)
        expect(await input.isEnabled()).toBe(true)
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
        if (!page) throw new Error('Browser page was not initialized')
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
      await expect.poll(async () => await input.isEnabled(), {
        timeout: 30_000,
      }).toBe(true)

      observedCalls.length = 0
      await dragNotebookConnection(page, imageCellId, imageTargetCellId)
      await expect.poll(() => observedCalls.some((call) =>
        call.name === 'connect_notebook_cells'
        && call.arguments.source_cell_id === imageCellId
        && call.arguments.target_cell_id === imageTargetCellId
        && call.arguments.target_input === 'image')).toBe(true)
      await expect.poll(async () => await input.isEnabled(), {
        timeout: 30_000,
      }).toBe(true)
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
        tool: 'generate_kie_seedance_2_5_video',
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
      notebookDirty = true
    }
  }, 60_000)

  it('opens generation output fullscreen and restores the trigger focus', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openApp()
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)
    await page.getByLabel('Open inspector').click()
    const generationNode = page.locator(
      `.notebook-flow .react-flow__node[data-id="${fullscreenImageGenerationCellId}"]`,
    )
    await generationNode.waitFor({ state: 'visible' })
    expect(await generationNode.locator('.cell-media').count()).toBe(0)
    expect((await generationNode.locator('.cell-model-line').textContent())?.trim())
      .toBe('Nano Banana Pro')
    expect((await generationNode.locator('.cell-copy-text p').textContent())?.trim())
      .toBe('A fullscreen image fixture')
    const fullscreenNode = page.locator(
      `.notebook-flow .react-flow__node[data-id="${fullscreenImageCellId}"]`,
    )
    const cardMedia = fullscreenNode.locator('.cell-media')
    const cardMetadata = fullscreenNode.locator('.cell-image-metadata')
    await cardMetadata.waitFor({ state: 'visible' })
    expect(await fullscreenNode.locator('.cell-media-caption').count()).toBe(0)
    expect(await cardMedia.getAttribute('title')).toBe('A fullscreen image fixture')
    const cardMediaBox = await cardMedia.boundingBox()
    const cardMetadataBox = await cardMetadata.boundingBox()
    if (!cardMediaBox || !cardMetadataBox) {
      throw new Error('Could not measure image card metadata')
    }
    const metadataTopInset = cardMetadataBox.y - cardMediaBox.y
    const metadataRightInset =
      cardMediaBox.x + cardMediaBox.width
        - cardMetadataBox.x - cardMetadataBox.width
    expect(metadataTopInset).toBeGreaterThanOrEqual(-1)
    expect(metadataTopInset).toBeLessThanOrEqual(16)
    expect(metadataRightInset).toBeGreaterThanOrEqual(-1)
    expect(metadataRightInset).toBeLessThanOrEqual(16)
    await fullscreenNode.click()
    const trigger = page.getByLabel('Open @c3 fullscreen')
    const editTrigger = page.getByLabel('Edit @c3 image')
    await trigger.waitFor({ state: 'visible' })
    await editTrigger.waitFor({ state: 'visible' })
    await wait(250)
    const inspectorHeaderBox = await page.locator('.inspector > header').boundingBox()
    const inspectorPreviewBox = await page.locator('.inspector-cell-preview').boundingBox()
    if (!inspectorHeaderBox || !inspectorPreviewBox) {
      throw new Error('Could not measure inspector preview spacing')
    }
    expect(
      inspectorPreviewBox.y - inspectorHeaderBox.y - inspectorHeaderBox.height,
    ).toBeLessThanOrEqual(56)
    const triggerBox = await trigger.boundingBox()
    if (!triggerBox) throw new Error('Could not measure fullscreen trigger')
    const editTriggerBox = await editTrigger.boundingBox()
    if (!editTriggerBox) throw new Error('Could not measure edit trigger')
    const actionBox = await trigger.locator('..').boundingBox()
    if (!actionBox) throw new Error('Could not measure image actions')
    expect(Math.abs(triggerBox.width - editTriggerBox.width)).toBeLessThanOrEqual(2)
    expect(triggerBox.width).toBeGreaterThan(actionBox.width * 0.35)
    expect(triggerBox.height).toBeGreaterThanOrEqual(44)
    const triggerPoint = {
      x: actionBox.x + actionBox.width - 10,
      y: triggerBox.y + triggerBox.height / 2,
    }
    expect(await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'), {
      x: triggerPoint.x,
      y: triggerPoint.y,
    })).toBe('Open @c3 fullscreen')

    const ordinaryDraft = 'Keep this ordinary chat draft'
    await input.fill(ordinaryDraft)
    await page.mouse.click(triggerPoint.x, triggerPoint.y)
    const dialog = page.getByRole('dialog', { name: 'Fullscreen preview for @c3' })
    await dialog.waitFor({ state: 'visible' })
    const modalInput = dialog.getByLabel('Videobook command input')
    await modalInput.waitFor({ state: 'visible' })
    expect(await modalInput.inputValue()).toBe('')
    expect(await dialog.getByText('@C3 IMAGE EDIT').isVisible()).toBe(true)
    expect(await dialog.getByLabel('Chat model').count()).toBe(0)
    expect(await dialog.locator('.command-suggestions').count()).toBe(0)
    expect(await dialog.locator('.command-composer').count()).toBe(1)
    const image = dialog.locator(
      '.notebook-subject-stage img, .notebook-subject-stage image',
    ).first()
    await image.waitFor({ state: 'visible' })
    expect(await image.evaluate((element) =>
      element instanceof HTMLImageElement
        ? element.src
        : element.getAttribute('href') ?? '')).toContain(fullscreenImageMediaUrl)
    const subjects = dialog.getByRole('button', { name: 'Subjects' })
    await subjects.waitFor({ state: 'visible' })
    expect(await subjects.isVisible()).toBe(true)
    expect(await dialog.getByRole('button', { name: 'Remove' }).isDisabled()).toBe(true)
    expect(await dialog.getByRole('button', { name: 'Edit selected' }).count()).toBe(0)
    expect(await dialog.getByLabel('Edit instruction').count()).toBe(0)
    expect(await page.locator('.app-shell').evaluate((element) => ({
      ariaHidden: element.getAttribute('aria-hidden'),
      inert: element instanceof HTMLElement ? element.inert : false,
    }))).toEqual({ ariaHidden: 'true', inert: true })
    await expect.poll(async () => await image.evaluate((element) => {
      if (!(element instanceof HTMLImageElement)) {
        return {
          complete: Boolean(element.getAttribute('href')),
          naturalWidth: Number(element.getAttribute('width')),
        }
      }
      return {
        complete: element.complete,
        naturalWidth: element.naturalWidth,
      }
    })).toEqual({ complete: true, naturalWidth: 1 })
    const close = page.getByLabel('Close fullscreen preview')
    expect(await close.evaluate((element) => document.activeElement === element)).toBe(true)

    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect(await input.inputValue()).toBe(ordinaryDraft)
    expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true)
    expect(await page.locator('.app-shell').evaluate((element) => ({
      ariaHidden: element.getAttribute('aria-hidden'),
      inert: element instanceof HTMLElement ? element.inert : false,
    }))).toEqual({ ariaHidden: null, inert: false })

    mockedFullscreenSubjectEditor = true
    await editTrigger.click()
    await dialog.waitFor({ state: 'visible' })
    await dialog.locator('.notebook-subject-row strong', {
      hasText: 'Foreground person',
    }).waitFor({ state: 'visible' })
    expect(await modalInput.inputValue()).toBe('')
    const subjectCheckbox = dialog.locator('.notebook-subject-row input[type="checkbox"]')
    await subjectCheckbox.check()
    await expect.poll(async () => await modalInput.getAttribute('placeholder'))
      .toContain('Foreground person')
    await page.evaluate(() => window.localStorage.setItem(
      'videobook.cloud-generation-consent',
      'accepted',
    ))
    observedCalls.length = 0
    const editPrompt = 'Replace the suit with a bright yellow raincoat'
    await modalInput.fill(editPrompt)
    await dialog.getByLabel('Send command').click()
    await expect.poll(() => observedCalls.find((call) =>
      call.name === 'edit_image_subjects')).toBeTruthy()
    expect(await dialog.getByRole('button', { name: 'Remove' }).isDisabled()).toBe(true)
    expect(await dialog.getByRole('button', { name: 'Hide subjects' }).isDisabled()).toBe(true)
    const editCall = observedCalls.find((call) => call.name === 'edit_image_subjects')
    expect(editCall?.arguments).toMatchObject({
      book_id: bookId,
      notebook_id: notebookId,
      source_cell_id: fullscreenImageCellId,
      artifact_id: fullscreenImageArtifactId,
      object_hash: fullscreenImageObjectHash,
      subject_ids: ['person-foreground'],
      operation: 'edit',
      prompt: editPrompt,
    })
    expect(observedCalls.some((call) => call.name === 'chat')).toBe(false)
    expect(observedCalls.some((call) => call.name === 'record_prompt')).toBe(false)
    expect(observedCalls.some((call) => call.name === 'list_prompt_history')).toBe(false)
    await dialog.locator('.command-result-ok').waitFor({ state: 'visible' })
    observedCalls.length = 0
    const remove = dialog.getByRole('button', { name: 'Remove' })
    await remove.click()
    await expect.poll(() => observedCalls.find((call) =>
      call.name === 'edit_image_subjects'
      && call.arguments.operation === 'remove')).toBeTruthy()
    expect(await modalInput.isDisabled()).toBe(true)
    await expect.poll(async () => await modalInput.isEnabled(), {
      timeout: 5_000,
    }).toBe(true)
    const completionBaseline = mockedSubjectEditCompletions
    mockedSubjectEditDelays = [1_000, 1_800]
    observedCalls.length = 0
    await remove.click()
    await expect.poll(() => observedCalls.filter((call) =>
      call.name === 'edit_image_subjects'
      && call.arguments.operation === 'remove').length).toBe(1)
    await close.click()
    await dialog.waitFor({ state: 'hidden' })
    await editTrigger.click()
    await dialog.waitFor({ state: 'visible' })
    await dialog.locator('.notebook-subject-row strong', {
      hasText: 'Foreground person',
    }).waitFor({ state: 'visible' })
    await subjectCheckbox.check()
    await remove.click()
    await expect.poll(() => observedCalls.filter((call) =>
      call.name === 'edit_image_subjects'
      && call.arguments.operation === 'remove').length).toBe(2)
    await expect.poll(() => mockedSubjectEditCompletions, {
      timeout: 5_000,
    }).toBe(completionBaseline + 1)
    expect(await modalInput.isDisabled()).toBe(true)
    await expect.poll(() => mockedSubjectEditCompletions, {
      timeout: 5_000,
    }).toBe(completionBaseline + 2)
    await expect.poll(async () => await modalInput.isEnabled(), {
      timeout: 5_000,
    }).toBe(true)
    await page.setViewportSize({ width: 420, height: 800 })
    const composerBox = await dialog.locator('.command-composer').boundingBox()
    const subjectPanelBox = await dialog.locator('.notebook-subject-panel').boundingBox()
    if (!composerBox || !subjectPanelBox) {
      throw new Error('Could not measure the mobile image editor layout')
    }
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(subjectPanelBox.y)
    await modalInput.fill('Unsent image edit draft')
    const send = dialog.getByLabel('Send command')
    await send.focus()
    await page.keyboard.press('Tab')
    expect(await close.evaluate((element) => document.activeElement === element)).toBe(true)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await close.click()
    await dialog.waitFor({ state: 'hidden' })
    expect(await input.inputValue()).toBe(ordinaryDraft)
    expect(await editTrigger.evaluate((element) => document.activeElement === element)).toBe(true)
    mockedFullscreenSubjectEditor = false
  }, 60_000)

  it('pauses the sidebar video when opening fullscreen playback', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openApp()
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)
    const reopen = page.getByLabel('Open inspector')
    if (await reopen.count()) await reopen.click()
    const videoNode = notebookCellNode(page, videoCellId)
    await videoNode.waitFor({ state: 'visible' })
    const videoAddress = (await videoNode.locator('.cell-node-footer strong')
      .textContent())?.trim()
    if (!videoAddress) throw new Error('Sidebar video address is missing')
    await videoNode.click()
    const sidebarVideo = page.locator('.inspector-cell-media video')
    await sidebarVideo.waitFor({ state: 'visible' })
    const sidebarPlaybackState = async () => await sidebarVideo.evaluate((element) =>
      element instanceof HTMLVideoElement
        ? { paused: element.paused, time: element.currentTime }
        : null)

    await sidebarVideo.evaluate((element) => {
      if (element instanceof HTMLVideoElement) void element.play()
    })
    await expect.poll(async () => {
      const state = await sidebarPlaybackState()
      return state !== null && !state.paused && state.time > 0
    }, { timeout: 10_000 }).toBe(true)

    await page.getByLabel(`Open ${videoAddress} fullscreen`).click()
    const dialog = page.getByRole('dialog', {
      name: `Fullscreen preview for ${videoAddress}`,
    })
    await dialog.waitFor({ state: 'visible' })
    await dialog.locator('video').waitFor({ state: 'visible' })
    const pausedAtOpen = await sidebarPlaybackState()
    expect(pausedAtOpen?.paused).toBe(true)
    await wait(700)
    expect(await sidebarPlaybackState()).toEqual(pausedAtOpen)

    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect(await sidebarPlaybackState()).toEqual(pausedAtOpen)
  }, 60_000)

  it('turns every open notebook square into a media file dropzone', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openApp()
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
        await page!.locator('.notebook-grid-square-dropzone').count(),
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
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            sessionStorage.setItem('videobook-test-clipboard', value)
          },
        },
      })
    })
    await openApp()
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
    await openApp()
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
      mockedWatermarkApply = true
      await openApp()
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

  it('uses one composer watermark review for routed and direct commands', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    const prompt = 'watermark @a1 with @justinwtanner'
    mockedChatActionPlan = {
      prompt,
      value: {
        kind: 'chat-action-plan',
        planId: '01900000-0000-7000-8000-000000000111',
        bookId,
        prompt,
        routedTool: 'apply_watermark',
        tool: 'apply_watermark',
        params: {
          asset_id: '@a1',
          handle: 'justinwtanner',
        },
        message: 'Applying watermark.',
        summary: 'Applying watermark.',
        effect: 'mutation',
        confirmation: {
          required: true,
          reason: 'This request changes the current book',
        },
      },
    }
    try {
      await openApp()
      const input = page.getByLabel('Videobook command input')
      await input.waitFor({ state: 'visible', timeout: 30_000 })
      await expect.poll(async () => await input.isEnabled()).toBe(true)
      const initialApplyCalls = observedCalls.filter((call) =>
        call.name === 'apply_watermark').length

      await input.fill(prompt)
      await page.getByLabel('Send command').click()

      const review = page.getByLabel('Watermark review')
      await review.waitFor({ state: 'visible', timeout: 30_000 })
      expect(await page.getByLabel('Chat action review').count()).toBe(0)
      expect(await page.locator('.watermark-chat-review').count()).toBe(1)
      expect(await page.locator('.watermark-backdrop, .watermark-dialog').count()).toBe(0)
      expect(await review.locator('video').count()).toBe(1)
      expect(await review.getByLabel('X handle').inputValue()).toBe('justinwtanner')
      expect(await review.getByRole('checkbox', { name: 'Include QR code' }).isChecked()).toBe(true)
      expect(await review.getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe('true')
      expect(await review.getByRole('button', { name: 'Top left' }).count()).toBe(1)
      expect(await review.locator('input[type="number"]').count()).toBe(2)
      await expect.poll(async () => await input.inputValue()).toBe('/apply')

      await review.getByRole('button', { name: 'Bottom left' }).click()
      expect(await review.getByRole('button', { name: 'Bottom left' })
        .getAttribute('aria-pressed')).toBe('true')
      await review.getByRole('checkbox', { name: 'Include QR code' }).uncheck()
      expect(await review.getByText('Handle only').count()).toBeGreaterThan(0)
      await review.locator('input[type="number"]').nth(0).fill('0.5')
      await review.locator('input[type="number"]').nth(1).fill('2.5')
      await review.getByRole('button', { name: 'Apply' }).click()
      await review.waitFor({ state: 'detached' })
      const applyCalls = observedCalls.filter((call) => call.name === 'apply_watermark')
      expect(applyCalls).toHaveLength(initialApplyCalls + 1)
      expect(applyCalls.at(-1)?.arguments).toMatchObject({
        book_id: bookId,
        asset_id: videoArtifactId,
        handle: 'justinwtanner',
        include_qr: false,
        position: 'bottom-left',
        start_seconds: 0.5,
        end_seconds: 2.5,
      })

      await input.fill('/watermark @a1')
      await page.getByLabel('Send command').click()
      await review.waitFor({ state: 'visible', timeout: 30_000 })
      expect(await page.locator('.watermark-chat-review').count()).toBe(1)
      expect(await page.locator('.watermark-backdrop, .watermark-dialog').count()).toBe(0)
      expect(await review.getByRole('button', { name: 'Top right' }).count()).toBe(1)
      await review.getByRole('button', { name: 'Cancel' }).click()
      expect(observedCalls.filter((call) => call.name === 'apply_watermark')).toHaveLength(
        initialApplyCalls + 1,
      )
    } finally {
      mockedWatermarkApply = false
      mockedChatActionPlan = null
    }
  }, 60_000)

  it('shows a live speed preview at the proposed rate before applying', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    const prompt = 'speed up @a1 to 1.3x'
    mockedChatActionPlan = {
      prompt,
      value: {
        kind: 'chat-action-plan',
        planId: '01900000-0000-7000-8000-000000000201',
        bookId,
        prompt,
        routedTool: 'change_video_speed',
        tool: 'change_video_speed',
        params: {
          asset_id: videoArtifactId,
          book_id: bookId,
          speed: 1.3,
        },
        message: 'Changing video speed.',
        summary: 'Changing video speed.',
        effect: 'mutation',
        confirmation: {
          required: true,
          reason: 'This request changes the current book',
        },
      },
    }
    try {
      await openApp()
      const input = page.getByLabel('Videobook command input')
      await input.waitFor({ state: 'visible', timeout: 30_000 })
      await expect.poll(async () => await input.isEnabled()).toBe(true)
      await input.fill(prompt)
      await page.getByLabel('Send command').click()

      const review = page.getByLabel('Chat action review')
      await review.waitFor({ state: 'visible', timeout: 30_000 })
      await review.getByText('Change video speed').waitFor({ state: 'visible' })
      await review.locator('.routed-action-settings dd', { hasText: '1.3×' })
        .first().waitFor({ state: 'visible' })
      await review.getByText('Source duration').waitFor({ state: 'visible' })

      // The proposed media preview plays live (controls, proposed playback
      // rate) against the cache-busted source URL without mutating it.
      const preview = review.locator('.routed-action-preview video')
      await preview.waitFor({ state: 'visible', timeout: 30_000 })
      expect(await preview.getAttribute('controls')).not.toBeNull()
      expect(await preview.getAttribute('loop')).not.toBeNull()
      expect(await preview.evaluate((element) => (element as HTMLVideoElement).muted))
        .toBe(true)
      expect(await preview.getAttribute('src')).toContain('/files/')
      await expect.poll(async () => await preview.evaluate((element) =>
        (element as HTMLVideoElement).playbackRate), { timeout: 30_000 })
        .toBe(1.3)

      // A paused preview is a failure: media must be ready, playing, and the
      // playhead must advance at the proposed rate.
      await expect.poll(async () => await preview.evaluate((element) => {
        const video = element as HTMLVideoElement
        return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused
      }), { timeout: 30_000 }).toBe(true)
      const firstTime = await preview.evaluate((element) =>
        (element as HTMLVideoElement).currentTime)
      await expect.poll(async () => await preview.evaluate((element) =>
        (element as HTMLVideoElement).currentTime), { timeout: 10_000 })
        .toBeGreaterThan(firstTime)
      await review.getByText('Live preview at 1.3× — source not yet changed')
        .waitFor({ state: 'visible' })

      // Cancel performs no mutation: the drawer closes, the cell stays put,
      // and no change_video_speed call reaches the server.
      const callsBeforeCancel = observedCalls.length
      await review.getByRole('button', { name: /Cancel/ }).click()
      await expect.poll(async () => await review.count()).toBe(0)
      expect(observedCalls.slice(callsBeforeCancel)
        .some((call) => call.name === 'change_video_speed')).toBe(false)
    } finally {
      mockedChatActionPlan = null
    }
  }, 60_000)

  it('derives the live preview rate from a target-duration plan', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    const prompt = 'speed up @a1 to fit 2 seconds'
    mockedChatActionPlan = {
      prompt,
      value: {
        kind: 'chat-action-plan',
        planId: '01900000-0000-7000-8000-000000000202',
        bookId,
        prompt,
        routedTool: 'change_video_speed',
        tool: 'change_video_speed',
        params: {
          asset_id: videoArtifactId,
          book_id: bookId,
          target_duration_seconds: 2,
        },
        message: 'Changing video speed.',
        summary: 'Changing video speed.',
        effect: 'mutation',
        confirmation: {
          required: true,
          reason: 'This request changes the current book',
        },
      },
    }
    try {
      await openApp()
      const input = page.getByLabel('Videobook command input')
      await input.waitFor({ state: 'visible', timeout: 30_000 })
      await expect.poll(async () => await input.isEnabled()).toBe(true)
      await input.fill(prompt)
      await page.getByLabel('Send command').click()

      const review = page.getByLabel('Chat action review')
      await review.waitFor({ state: 'visible', timeout: 30_000 })
      await review.getByText('Change video speed').waitFor({ state: 'visible' })
      // The fixture source is 3s, so a 2s target yields an effective 1.5×.
      await review.locator('.routed-action-settings dd', { hasText: '1.5×' })
        .first().waitFor({ state: 'visible' })

      const preview = review.locator('.routed-action-preview video')
      await preview.waitFor({ state: 'visible', timeout: 30_000 })
      await expect.poll(async () => await preview.evaluate((element) =>
        (element as HTMLVideoElement).playbackRate), { timeout: 30_000 })
        .toBe(1.5)
      await expect.poll(async () => await preview.evaluate((element) => {
        const video = element as HTMLVideoElement
        return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused
      }), { timeout: 30_000 }).toBe(true)
      const firstTime = await preview.evaluate((element) =>
        (element as HTMLVideoElement).currentTime)
      await expect.poll(async () => await preview.evaluate((element) =>
        (element as HTMLVideoElement).currentTime), { timeout: 10_000 })
        .toBeGreaterThan(firstTime)
      await review.getByText('Live preview at 1.5× — source not yet changed')
        .waitFor({ state: 'visible' })

      const callsBeforeCancel = observedCalls.length
      await review.getByRole('button', { name: /Cancel/ }).click()
      await expect.poll(async () => await review.count()).toBe(0)
      expect(observedCalls.slice(callsBeforeCancel)
        .some((call) => call.name === 'change_video_speed')).toBe(false)
    } finally {
      mockedChatActionPlan = null
    }
  }, 60_000)

  it('shows MCP motion and sends the selected model through the real UI', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    delayChatResponses = true
    await openApp({ cold: true })
    const startup = page.locator('#startup-shell')
    await startup.waitFor({ state: 'visible' })
    await expect.poll(async () => await startup.textContent()).toContain('Loading workspace via MCP')
    const startupAnimation = await page.locator('#startup-signal').evaluate((element) =>
      window.getComputedStyle(element, '::after').animationName)
    expect(startupAnimation).toContain('startup-scan')

    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)
    const workflowEdges = page.locator('.notebook-flow .react-flow__edge.workflow-edge')
    const routePaths = page.locator('.notebook-flow .workflow-edge .react-flow__edge-path')
    await expect.poll(async () => await workflowEdges.count()).toBeGreaterThan(0)
    await expect.poll(async () => await routePaths.count())
      .toBe(await workflowEdges.count())
    const routeStyles = await routePaths.evaluateAll((paths) => paths.map((path) => ({
      d: path.getAttribute('d'),
      stroke: window.getComputedStyle(path).stroke,
      strokeWidth: window.getComputedStyle(path).strokeWidth,
    })))
    expect(routeStyles).toHaveLength(await workflowEdges.count())
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
    const workingIndicator = page.locator('.command-send .busy-indicator')
    await workingIndicator.waitFor({ state: 'visible' })
    await wait(220)
    const workingBox = await workingIndicator.boundingBox()
    expect(await workingIndicator.evaluate((element) =>
      window.getComputedStyle(element.querySelector('svg')!).animationName))
      .toBe('busy-signal-beat')
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

  it('starts cell-level image and video generation without chat review', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openApp()
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)
    const reopenInspector = page.getByLabel('Open inspector')
    if (await reopenInspector.isVisible()) await reopenInspector.click()
    await page.evaluate(() => window.localStorage.setItem(
      'videobook.cloud-generation-consent',
      'accepted',
    ))

    const expectDirectStart = async (cellId: string) => {
      await notebookCellNode(page!, cellId).click()
      const generate = page!.getByLabel('Primary cell action')
        .getByRole('button', { name: 'Generate' })
      await expect.poll(async () => await generate.isEnabled()).toBe(true)
      observedCalls.length = 0
      await generate.click({ timeout: 10_000 })
      await expect.poll(() => observedCalls.some((call) =>
        call.name === 'plan_notebook_generation'
        && call.arguments.cell_id === cellId), {
        timeout: 20_000,
      }).toBe(true)
      await expect.poll(() => observedCalls.some((call) =>
        call.name === 'run_notebook_cell'
        && call.arguments.cell_id === cellId), {
        timeout: 20_000,
      }).toBe(true)
      expect(await page!.getByLabel('Command plan review').count()).toBe(0)
      expect(await input.inputValue()).toBe('')
      const runCall = observedCalls.find((call) =>
        call.name === 'run_notebook_cell'
        && call.arguments.cell_id === cellId)
      expect(record(runCall?.arguments.plan)?.planId).toEqual(expect.any(String))
    }

    await expectDirectStart(reviewGenerationCellId)
    await expectDirectStart(directVideoGenerationCellId)
    notebookDirty = true
  }, 60_000)

  it('keeps dense generation card headers compact and vertically centered', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openApp()
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

  it('reviews and applies a multi-cut split without a draggable timeline', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openApp()
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    await input.fill('/split @a1')
    await page.getByLabel('Send command').click()
    const review = page.getByLabel('Video split review')
    await review.waitFor({ state: 'visible', timeout: 30_000 })
    expect(await review.locator('video').count()).toBe(3)
    expect(await review.locator('input[type="range"]').count()).toBe(0)
    expect(await review.getByRole('button', { name: 'KEEP segment' }).count()).toBe(1)
    expect(await review.getByRole('button', { name: 'REMOVE segment' }).count()).toBe(1)
    expect(await review.getByRole('button', { name: 'ALL pieces' }).count()).toBe(1)
    const rangeResponse = await review.locator('video').first().evaluate(
      async (video) => {
        const response = await fetch((video as HTMLVideoElement).src, {
          headers: { Range: 'bytes=0-15' },
        })
        return {
          bytes: (await response.arrayBuffer()).byteLength,
          contentRange: response.headers.get('content-range'),
          status: response.status,
        }
      },
    )
    expect(rangeResponse).toMatchObject({
      bytes: 16,
      contentRange: expect.stringMatching(/^bytes 0-15\/\d+$/u),
      status: 206,
    })
    const outSeconds = review.getByLabel('OUT seconds')
    await expect.poll(async () => await outSeconds.inputValue()).toBe('1.500')

    const outRow = review.locator('.video-segment-bound-row').filter({ hasText: 'OUT' })
    await outRow.getByRole('button', { name: '+0.1s' }).click()
    await expect.poll(async () => await outSeconds.inputValue()).toBe('1.600')
    await outRow.getByRole('button', { name: '+0.1s' }).press('ArrowRight')
    await expect.poll(async () => await outSeconds.inputValue()).toBe('1.700')
    await review.getByRole('button', { name: /Split piece in half/ }).click()
    await expect.poll(async () => await review.locator('.video-segment-piece').count())
      .toBe(3)

    observedCalls.length = 0
    await review.getByRole('button', { name: 'Apply split' }).click()
    await review.waitFor({ state: 'hidden', timeout: 30_000 })
    await expect.poll(() => observedCalls.some((call) =>
      call.name === 'create_notebook_cell'
      && record(call.arguments.cell)?.type === 'split_video'
      && record(call.arguments.cell)?.operation === 'split_at_points')).toBe(true)
    await expect.poll(() => observedCalls.some((call) =>
      call.name === 'run_notebook')).toBe(true)

    const splitClient = new Client(
      { name: 'videobook-split-ui-e2e', version: '1.0.0' },
      {
        capabilities: {},
        supportedProtocolVersions: ['2026-07-28'],
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    )
    await splitClient.connect(
      new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp`)),
    )
    try {
      const document = record(resultValue(await splitClient.callTool({
        name: 'get_notebook',
        arguments: { book_id: bookId, notebook_id: notebookId },
      })))
      const cells = (Array.isArray(document?.cells) ? document.cells : [])
        .map(record)
        .filter((cell): cell is Record<string, unknown> => cell !== null)
      const splitCell = cells.find((cell) =>
        cell.type === 'split_video'
        && cell.operation === 'split_at_points'
        && record(cell.inputs)?.sourceCellId === videoCellId)
      expect(splitCell).toMatchObject({
        id: expect.any(String),
        inputs: { cutPointsSeconds: [0.85, 1.7] },
      })
      const outputCells = cells.filter((cell) =>
        record(cell.inputs)?.producerCellId === splitCell?.id)
      expect(outputCells.map((cell) => cell.label)).toEqual([
        'Chunk 01',
        'Chunk 02',
        'Chunk 03',
      ])
      const edges = (Array.isArray(document?.edges) ? document.edges : [])
        .map(record)
        .filter((edge): edge is Record<string, unknown> => edge !== null)
      expect(edges.filter((edge) => edge.source === splitCell?.id).map((edge) =>
        edge.target)).toEqual(expect.arrayContaining(
        outputCells.map((cell) => cell.id),
      ))
    } finally {
      await splitClient.close()
    }
    expect(await notebookCellNode(page, videoCellId).count()).toBe(1)
    notebookDirty = true
  }, 60_000)

  it('opens a complete context menu from every cell tile with delete last', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openApp()
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const cells = page.locator('.cell-node')
    const triggers = page.locator('.cell-context-menu-trigger')
    await expect.poll(async () => await triggers.count()).toBe(await cells.count())

    const target = notebookCellNode(page, directVideoGenerationCellId)
    await target.waitFor({ state: 'visible' })
    const address = (await target.locator('.cell-node-footer strong').textContent())?.trim()
    if (!address) throw new Error('Context menu target address is missing')

    await target.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: `Cell actions for ${address}` })
    await menu.waitFor({ state: 'visible' })
    expect(await target.getAttribute('data-selection')).toBe('primary')
    const itemLabels = (await menu.getByRole('menuitem').allTextContents())
      .map((label) => label.replace('⌫', '').trim())
    const requiredLabels = [
      'Edit cell',
      'Generate',
      'View generations',
      'View source',
      'Delete cell',
    ]
    expect(itemLabels.filter((label) => requiredLabels.includes(label)))
      .toEqual(requiredLabels)
    expect(itemLabels.at(-1)).toBe('Delete cell')
    expect(new Set(itemLabels).size).toBe(itemLabels.length)
    expect(itemLabels.filter((label) => !requiredLabels.includes(label)).every((label) =>
      [
        'Open media',
        'Extract frame',
        'Generate video',
        'Generate image',
        'Duplicate',
        'Split video',
        'Arrange videos in column',
        'Arrange videos in row',
      ].includes(label))).toBe(true)
    expect(await menu.locator('.cell-context-menu-danger').evaluate((element) =>
      getComputedStyle(element).borderTopStyle)).toBe('solid')
    const menuBox = await menu.boundingBox()
    if (!menuBox) throw new Error('Could not measure cell context menu')
    expect(menuBox.x).toBeGreaterThanOrEqual(8)
    expect(menuBox.y).toBeGreaterThanOrEqual(8)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1432)
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(992)

    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })

    const trigger = target.getByLabel(`Open ${address} cell menu`)
    await trigger.focus()
    await page.keyboard.press('Enter')
    await menu.waitFor({ state: 'visible' })
    await expect.poll(async () => await menu.getByRole('menuitem').first()
      .evaluate((element) => document.activeElement === element)).toBe(true)
    await page.keyboard.press('End')
    expect(await menu.getByRole('menuitem').last().evaluate((element) =>
      document.activeElement === element)).toBe(true)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    expect(await trigger.evaluate((element) => document.activeElement === element))
      .toBe(true)

    observedCalls.length = 0
    await trigger.click()
    await menu.waitFor({ state: 'visible' })
    const cancelledDelete = new Promise<string>((resolve) => {
      page!.once('dialog', async (dialog) => {
        resolve(dialog.message())
        await dialog.dismiss()
      })
    })
    await menu.getByRole('menuitem', { name: /Delete cell/ }).click()
    expect(await cancelledDelete).toContain(`Delete ${address}?`)
    expect(observedCalls.some((call) => call.name === 'delete_notebook_cell'))
      .toBe(false)
    expect(await target.count()).toBe(1)

    const videoTarget = notebookCellNode(page, videoCellId)
    const videoAddress = (await videoTarget.locator('.cell-node-footer strong')
      .textContent())?.trim()
    if (!videoAddress) throw new Error('Video context menu address is missing')
    await videoTarget.click({ button: 'right' })
    const videoMenu = page.getByRole('menu', {
      name: `Cell actions for ${videoAddress}`,
    })
    await videoMenu.waitFor({ state: 'visible' })
    expect((await videoMenu.getByRole('menuitem').allTextContents())
      .map((label) => label.replace('⌫', '').trim())).toEqual([
      'Edit cell',
      'Open media',
      'Extract frame',
      'Generate video',
      'Duplicate',
      'Arrange videos in column',
      'Arrange videos in row',
      'Split video',
      'View generations',
      'View source',
      'Delete cell',
    ])
    expect(await videoMenu.getByRole('menuitem', { name: 'Duplicate' }).isDisabled())
      .toBe(true)
    await videoMenu.getByRole('menuitem', { name: 'Open media' }).click()
    const fullscreen = page.getByRole('dialog', {
      name: `Fullscreen preview for ${videoAddress}`,
    })
    await fullscreen.waitFor({ state: 'visible' })
    await page.getByLabel('Close fullscreen preview').click()
    await fullscreen.waitFor({ state: 'hidden' })

    const duplicateSource = notebookCellNode(page, fullscreenImageCellId)
    const duplicateSourceAddress = (await duplicateSource
      .locator('.cell-node-footer strong').textContent())?.trim()
    if (!duplicateSourceAddress) throw new Error('Duplicate source address is missing')
    await duplicateSource.click({ button: 'right' })
    const duplicateMenu = page.getByRole('menu', {
      name: `Cell actions for ${duplicateSourceAddress}`,
    })
    await duplicateMenu.waitFor({ state: 'visible' })
    expect((await duplicateMenu.getByRole('menuitem').allTextContents())
      .map((label) => label.replace('⌫', '').trim())).toEqual([
      'Edit cell',
      'Open media',
      'Generate video',
      'Generate image',
      'Duplicate',
      'Arrange videos in column',
      'Arrange videos in row',
      'View generations',
      'View source',
      'Delete cell',
    ])
    for (const generation of [
      { label: 'Generate video', cellType: 'generate_video' },
      { label: 'Generate image', cellType: 'generate_image' },
    ] as const) {
      observedCalls.length = 0
      await duplicateMenu.getByRole('menuitem', { name: generation.label }).click()
      await expect.poll(() => observedCalls.find((call) =>
        call.name === 'create_notebook_cell'
        && record(call.arguments.cell)?.type === generation.cellType)).toBeTruthy()
      const createGenerationCall = observedCalls.find((call) =>
        call.name === 'create_notebook_cell'
        && record(call.arguments.cell)?.type === generation.cellType)
      const createdGenerationCell = record(createGenerationCall?.arguments.cell)
      const createdGenerationCellId = typeof createdGenerationCell?.id === 'string'
        ? createdGenerationCell.id
        : ''
      if (!createdGenerationCellId) {
        throw new Error('Context-menu generation did not preserve its planned cell id')
      }
      expect(createdGenerationCell).toMatchObject({
        provider: expect.any(String),
        tool: expect.any(String),
      })
      await expect.poll(() => observedCalls.some((call) =>
        call.name === 'connect_notebook_cells'
        && call.arguments.source_cell_id === fullscreenImageCellId
        && call.arguments.target_cell_id === createdGenerationCellId
        && call.arguments.target_input === 'image')).toBe(true)
      const createdGenerationNode = notebookCellNode(page, createdGenerationCellId)
      await createdGenerationNode.waitFor({ state: 'visible', timeout: 30_000 })
      expect(await createdGenerationNode.getAttribute('data-selection')).toBe('primary')

      await createdGenerationNode.click({ button: 'right' })
      const createdGenerationMenu = page.getByRole('menu', {
        name: /Cell actions for/,
      })
      await createdGenerationMenu.waitFor({ state: 'visible' })
      const confirmedGenerationCleanup = new Promise<string>((resolve) => {
        page!.once('dialog', async (dialog) => {
          resolve(dialog.message())
          await dialog.accept()
        })
      })
      await createdGenerationMenu.getByRole('menuitem', { name: /Delete cell/ }).click()
      expect(await confirmedGenerationCleanup).toContain('Delete @')
      await createdGenerationNode.waitFor({ state: 'hidden', timeout: 30_000 })
      await expect.poll(async () => await input.isEnabled()).toBe(true)

      await duplicateSource.click({ button: 'right' })
      await duplicateMenu.waitFor({ state: 'visible' })
    }
    const duplicateAction = duplicateMenu.getByRole('menuitem', { name: 'Duplicate' })
    expect(await duplicateAction.isEnabled()).toBe(true)
    observedCalls.length = 0
    await duplicateAction.click()
    await expect.poll(() => observedCalls.some((call) =>
      call.name === 'duplicate_asset'
      && call.arguments.book_id === bookId
      && call.arguments.notebook_id === notebookId
      && typeof call.arguments.asset_id === 'string')).toBe(true)
    const duplicatedCell = page.locator('.cell-node').filter({
      has: page.locator('.cell-node-footer strong', { hasText: /^@d3$/u }),
    })
    await duplicatedCell.waitFor({ state: 'visible', timeout: 30_000 })
    expect(await duplicatedCell.getAttribute('data-selection')).toBe('primary')

    await duplicatedCell.click({ button: 'right' })
    const duplicatedCellMenu = page.getByRole('menu', {
      name: 'Cell actions for @d3',
    })
    await duplicatedCellMenu.waitFor({ state: 'visible' })
    const confirmedCleanup = new Promise<string>((resolve) => {
      page!.once('dialog', async (dialog) => {
        resolve(dialog.message())
        await dialog.accept()
      })
    })
    await duplicatedCellMenu.getByRole('menuitem', { name: /Delete cell/ }).click()
    expect(await confirmedCleanup).toContain('Delete @d3?')
    await duplicatedCell.waitFor({ state: 'hidden', timeout: 30_000 })

    const emptyMediaTarget = notebookCellNode(page, imageCellId)
    const emptyMediaAddress = (await emptyMediaTarget
      .locator('.cell-node-footer strong').textContent())?.trim()
    if (!emptyMediaAddress) throw new Error('Empty media context menu address is missing')
    await emptyMediaTarget.click({ button: 'right' })
    const emptyMediaMenu = page.getByRole('menu', {
      name: `Cell actions for ${emptyMediaAddress}`,
    })
    await emptyMediaMenu.waitFor({ state: 'visible' })
    expect((await emptyMediaMenu.getByRole('menuitem').allTextContents())
      .map((label) => label.replace('⌫', '').trim())).toEqual([
      'Edit cell',
      'Choose media',
      'Arrange videos in column',
      'Arrange videos in row',
      'View generations',
      'View source',
      'Delete cell',
    ])
    await emptyMediaMenu.getByRole('menuitem', { name: 'Choose media' }).click()
    const mediaLibrary = page.getByRole('dialog', { name: 'Choose image media' })
    await mediaLibrary.waitFor({ state: 'visible' })
    await page.getByLabel('Close media library').click()
    await mediaLibrary.waitFor({ state: 'hidden' })

    const runningTarget = notebookCellNode(page, generationCellId)
    const runningAddress = (await runningTarget.locator('.cell-node-footer strong')
      .textContent())?.trim()
    if (!runningAddress) throw new Error('Running cell context menu address is missing')
    await runningTarget.getByLabel(`Open ${runningAddress} cell menu`).click()
    const runningMenu = page.getByRole('menu', {
      name: `Cell actions for ${runningAddress}`,
    })
    await runningMenu.waitFor({ state: 'visible' })
    expect(await runningMenu.locator('[data-cell-action="run"]').isDisabled())
      .toBe(true)
    await page.keyboard.press('Escape')
  }, 60_000)

  it('marquee-selects multiple cells and confirms before deleting the set', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openApp()
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
    notebookDirty = true
  }, 60_000)

  it('searches the header add menu and closes it after adding a cell', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openApp()
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const menu = page.locator('.canvas-add-menu')
    await menu.locator('summary').click()
    const search = page.getByLabel('Search cell types')
    await search.fill('generate audio')
    expect(await menu.getByRole('button').allTextContents()).toEqual(['Generate audio'])

    observedCalls.length = 0
    await menu.getByRole('button', { name: 'Generate audio' }).click()
    await expect.poll(async () => await menu.getAttribute('open')).toBeNull()
    await expect.poll(() => observedCalls.some((call) =>
      call.name === 'create_notebook_cell'
      && record(call.arguments.cell)?.type === 'generate_audio')).toBe(true)
    notebookDirty = true
  }, 60_000)

  it('auto-arranges the notebook into left-aligned workflow bands', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await openApp()
    const input = page.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)

    const selected = notebookCellNode(page, fullscreenImageCellId)
    await selected.click()
    expect(await selected.getAttribute('data-selection')).toBe('primary')
    await page.getByLabel('Zoom out').click()
    const zoomLevel = page.getByLabel('Reset zoom')
    await expect.poll(async () => await zoomLevel.textContent()).toContain('75%')

    const autoArrange = page.getByLabel('Auto-arrange notebook')
    await autoArrange.waitFor({ state: 'visible' })
    expect(await autoArrange.getAttribute('title')).toBe('Auto-arrange notebook')
    observedCalls.length = 0
    await autoArrange.click()
    await expect.poll(() => observedCalls.filter((call) =>
      call.name === 'move_notebook_cells')).toHaveLength(1)
    const moveCall = observedCalls.find((call) => call.name === 'move_notebook_cells')
    const slots = Array.isArray(moveCall?.arguments.slots)
      ? moveCall.arguments.slots.map(record).filter((slot) => slot !== null)
      : []
    const slotKeys = new Set(slots.map((slot) => `${slot!.row}:${slot!.column}`))
    const slotsById = new Map(slots.flatMap((slot) =>
      typeof slot?.id === 'string' ? [[slot.id, slot] as const] : []))
    const generationSlot = slotsById.get(fullscreenImageGenerationCellId)
    const imageSlot = slotsById.get(fullscreenImageCellId)
    const occupiedRows = new Set(slots.map((slot) => Number(slot!.row)))
    const minRow = Math.min(...occupiedRows)
    const maxRow = Math.max(...occupiedRows)
    const blankRows = Array.from(
      { length: Math.max(0, maxRow - minRow - 1) },
      (_, index) => minRow + 1 + index,
    ).filter((row) => !occupiedRows.has(row))

    expect(moveCall?.arguments.book_id).toBe(bookId)
    expect(moveCall?.arguments.notebook_id).toBe(notebookId)
    expect(typeof moveCall?.arguments.expected_revision).toBe('string')
    expect(slots.length).toBeGreaterThan(0)
    expect(slotKeys.size).toBe(slots.length)
    expect(slots.every((slot) =>
      Number(slot!.column) >= 0 && Number(slot!.column) <= 6)).toBe(true)
    expect(slots.every((slot) =>
      Number(slot!.row) >= 0 && Number(slot!.row) <= 25)).toBe(true)
    expect(typeof generationSlot?.row).toBe('number')
    expect(typeof imageSlot?.row).toBe('number')
    expect(Number(imageSlot?.row)).toBe(Number(generationSlot?.row))
    expect(Number(imageSlot?.column)).toBe(Number(generationSlot?.column) + 1)
    expect(blankRows.length).toBeGreaterThan(0)
    await page.getByText(/^Auto-arranged \d+ tiles?$/u).waitFor({
      state: 'visible',
      timeout: 30_000,
    })
    await expect.poll(async () => await autoArrange.isEnabled()).toBe(true)
    await expect.poll(async () => await page!.locator('.notebook-horizontal-scroll')
      .evaluate((element) => ({
        left: element.scrollLeft,
        top: element.scrollTop,
      }))).toMatchObject({ top: 0 })
    await expect.poll(async () => await page!.locator('.notebook-horizontal-scroll')
      .evaluate((element) => element.scrollLeft)).toBe(0)
    expect(await zoomLevel.textContent()).toContain('75%')
    expect(await selected.getAttribute('data-selection')).toBe('primary')

    observedCalls.length = 0
    await autoArrange.click()
    await page.getByText('Notebook is already auto-arranged').waitFor({
      state: 'visible',
    })
    expect(observedCalls.some((call) => call.name === 'move_notebook_cells'))
      .toBe(false)
    notebookDirty = true
  }, 60_000)
})
