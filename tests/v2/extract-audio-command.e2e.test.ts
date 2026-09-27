import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import {
  availablePort,
  record,
  requestBody,
  resultValue,
  startProcess,
  stopProcess,
  toolCalls,
  waitForHttp,
  type ObservedToolCall,
  type StartedProcess,
} from './e2e-harness'

const execFileAsync = promisify(execFile)

// The real extraction on a one-second clip takes well under this; the bound
// only has to be far below the five-minute watch timeout the regression hid
// behind (a fake "reused" run that never completed).
const EXTRACTION_TIMEOUT_MS = 30_000

describe('extract audio composer flow', () => {
  let rootDir = ''
  let mcpProcess: StartedProcess | undefined
  let viteProcess: StartedProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let appUrl = ''
  let sourceCellId = ''
  const observedCalls: ObservedToolCall[] = []

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-extract-audio-e2e-'))
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
      { name: 'videobook-extract-audio-e2e', version: '1.0.0' },
      {
        capabilities: {},
        supportedProtocolVersions: ['2026-07-28'],
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    )
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp`)))
    await client.callTool({ name: 'create_book', arguments: { name: 'extract-audio-e2e' } })
    const booksValue = resultValue(await client.callTool({
      name: 'list_books',
      arguments: { sort: 'newest' },
    }))
    const book = (Array.isArray(booksValue) ? booksValue : [])
      .map(record)
      .find((entry) => entry?.name === 'extract-audio-e2e')
    const bookId = typeof book?.bookId === 'string' ? book.bookId : ''
    if (!bookId) throw new Error('Could not create the e2e book')
    const notebooksValue = resultValue(await client.callTool({
      name: 'list_notebooks',
      arguments: { book_id: bookId },
    }))
    const notebook = (Array.isArray(notebooksValue) ? notebooksValue : [])
      .map(record)
      .find(Boolean)
    const notebookId = typeof notebook?.id === 'string' ? notebook.id : ''
    if (!notebookId) throw new Error('Could not find the e2e notebook')

    const sourcePath = join(rootDir, 'source.mp4')
    await execFileAsync(FFMPEG, [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=blue:s=64x64:r=24:d=1',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
      '-shortest',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      sourcePath,
    ])
    const uploaded = record(resultValue(await client.callTool({
      name: 'upload_file',
      arguments: {
        book_id: bookId,
        filename: 'source.mp4',
        data: (await readFile(sourcePath)).toString('base64'),
      },
    })))
    const uploadedId = typeof uploaded?.assetId === 'string' ? uploaded.assetId : ''
    const assetsValue = record(resultValue(await client.callTool({
      name: 'list_assets',
      arguments: { book_id: bookId, sort: 'newest' },
    })))
    const uploadedAsset = (Array.isArray(assetsValue?.assets) ? assetsValue.assets : [])
      .map(record)
      .find((asset) => asset?.id === uploadedId)
    const artifactId = typeof uploadedAsset?.artifact_id === 'string'
      ? uploadedAsset.artifact_id
      : ''
    if (!artifactId) throw new Error('Could not upload the e2e source video')
    const created = record(resultValue(await client.callTool({
      name: 'create_notebook_cell',
      arguments: {
        book_id: bookId,
        notebook_id: notebookId,
        cell: {
          type: 'video',
          label: 'source clip',
          slot: { row: 0, column: 0 },
          output_artifact_id: artifactId,
          inputs: { durationSeconds: 1 },
        },
      },
    })))
    sourceCellId = typeof created?.id === 'string' ? created.id : ''
    if (!sourceCellId) throw new Error('Could not create the e2e source cell')
    await client.close()

    viteProcess = startProcess(
      [
        join(process.cwd(), 'node_modules/vite/bin/vite.js'),
        '--host', '127.0.0.1',
        '--port', String(vitePort),
      ],
      { ...process.env, VIDEOBOOK_SERVER_URL: mcpOrigin, VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache') },
    )
    await waitForHttp(appUrl, viteProcess, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.route('**/mcp', async (route) => {
      observedCalls.push(...toolCalls(await requestBody(route)))
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

  function audioCell(target: Page) {
    return target.locator('.notebook-flow .react-flow__node .cell-node.cell-kind-audio')
  }

  async function submitCommand(target: Page, command: string): Promise<void> {
    const input = target.getByLabel('Videobook command input')
    await input.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => await input.isEnabled()).toBe(true)
    await input.fill(command)
    await target.getByLabel('Send command').click()
  }

  async function waitForCompletedAudioCell(
    target: Page,
    versionLabel: string | null,
  ): Promise<void> {
    const cell = audioCell(target)
    await expect.poll(
      async () => {
        if (await cell.count() !== 1) return 'missing'
        const className = await cell.getAttribute('class') ?? ''
        const text = await cell.innerText()
        if (className.includes('cell-node-queued')) return 'queued'
        if (className.includes('cell-node-error')) return 'error'
        if (!/Audio output/.test(text)) return 'pending'
        if (versionLabel && !text.includes(versionLabel)) return 'previous-version'
        return 'completed'
      },
      { timeout: EXTRACTION_TIMEOUT_MS, interval: 100 },
    ).toBe('completed')
  }

  async function waitForComposerResult(target: Page, text: string): Promise<void> {
    await target.locator('.chat-bubble-assistant, .command-result-ok', { hasText: text }).last()
      .waitFor({ state: 'visible', timeout: 10_000 })
  }

  async function waitForComposerToClear(target: Page): Promise<void> {
    await expect.poll(
      async () => await target.locator('.chat-turn').last().getAttribute('data-status'),
      { timeout: 20_000, interval: 200 },
    ).toBe('completed')
  }

  it('extracts audio from the composer, then re-runs the same cell on repeat', async () => {
    if (!page) throw new Error('Browser page was not initialized')
    await page.goto(appUrl, { waitUntil: 'commit' })
    await page.locator(
      `.notebook-flow .react-flow__node[data-id="${sourceCellId}"] .cell-node`,
    ).waitFor({ state: 'visible', timeout: 30_000 })

    await submitCommand(page, '/extract-audio @a1')
    await waitForComposerResult(page, 'Audio extraction queued for @a1')
    await waitForCompletedAudioCell(page, null)
    await waitForComposerResult(page, 'Extracted audio from @a1')
    expect(observedCalls.some((call) => call.name === 'extract_notebook_audio')).toBe(true)
    expect(observedCalls.some((call) => call.name === 'run_notebook_cell')).toBe(false)
    expect(await audioCell(page).innerText()).not.toContain('v2/2')
    await waitForComposerToClear(page)

    // Repeating the command for the same source must re-run the existing cell
    // through the server (a real run with a real job) and settle again — not
    // park the cell in QUEUED behind a placeholder run id.
    const callsBeforeRepeat = observedCalls.length
    await submitCommand(page, '/extract-audio @a1')
    await waitForComposerResult(page, 'Audio extraction queued for @a1')
    await expect.poll(
      () => observedCalls.slice(callsBeforeRepeat).map((call) => call.name),
      { timeout: 10_000, interval: 100 },
    ).toContain('run_notebook_cell')
    await waitForCompletedAudioCell(page, 'v2/2')
    await waitForComposerResult(page, 'Extracted audio from @a1')
    const repeatCalls = observedCalls.slice(callsBeforeRepeat)
    expect(repeatCalls.some((call) => call.name === 'extract_notebook_audio')).toBe(false)
    expect(await audioCell(page).count()).toBe(1)
    expect(await page.locator('.command-result-error').count()).toBe(0)
  }, 120_000)
})
