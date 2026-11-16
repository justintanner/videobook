import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium, type Browser, type Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeAnalysisComponent } from '../../server/src/analysis-components.js'
import { BookManager } from '../../server/src/book-manager.js'
import { MANAGED_ENV_KEYS } from '../../server/src/env-secrets.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { registerMediaProbe } from '../../server/src/notebook-media-ops.js'
import { testBudget } from '../../server/src/test-budget.js'
import { extractVideoPoster } from '../../server/src/video-poster.js'
import { CLEANUP_DETECTION, cleanupDetectionKey } from '../../server/src/video-cleanup/service.js'
import { cleanupSource } from '../../server/src/video-cleanup/source.js'
import { availablePort, resultValue, startProcess, stopProcess, waitForHttp, type StartedProcess } from './e2e-harness.js'

const exec = promisify(execFile)
const REAL_MODELS = process.env.VIDEOBOOK_RUN_CLEANUP_MODELS === '1'

describe('local video graphics remover', () => {
  let root = '', bookId = '', sourceId = '', notebookId = '', origin = ''
  let server: StartedProcess | undefined, vite: StartedProcess | undefined, browser: Browser | undefined, client: Client | undefined
  let page: Page
  const errors: string[] = []
  const sheet = () => page.getByRole('dialog', { name: 'Video graphics remover', exact: true })
  const call = async (name: string, args: Record<string, unknown>) => resultValue(await client!.callTool({ name, arguments: { book_id: bookId, ...args } }))

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-cleanup-ui-'))
    const overlay = join(root, 'title.png'), video = join(root, 'title.mp4')
    await sharp(Buffer.from('<svg width="512" height="320"><text x="60" y="180" font-family="Arial" font-size="42" fill="white">HELLO WORLD</text></svg>')).png().toFile(overlay)
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x5688a1:s=512x320:r=6:d=2', '-i', overlay,
      '-filter_complex', "[0:v][1:v]overlay=0:0:enable='gte(t,0.5)*lt(t,1.5)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { timeout: testBudget(60_000) })
    const books = new BookManager({ libraryDir: join(root, 'books') })
    const created = await books.create('cleanup-ui')
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const found = books.get(bookId)
    if (!found.ok) throw new Error(found.error.message)
    const engine = found.value.engine
    const asset = await engine.artifacts.create('video', 'Title fixture')
    if (!asset.ok) throw new Error(asset.error.message)
    sourceId = asset.value.artifactId
    await engine.files.writeFromPath(sourceId, 'original.mp4', video)
    await registerMediaProbe(engine, sourceId, 'original.mp4', await probeVideo(video))
    await engine.files.write(sourceId, 'original.jpg', await extractVideoPoster(video, 2))
    notebookId = engine.notebooks.list()[0]!.id
    await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: 'video', slot: { row: 0, column: 0 }, outputArtifactId: sourceId }))
    if (!REAL_MODELS) {
      const source = await cleanupSource(engine, sourceId)
      writeAnalysisComponent(engine, {
        component: CLEANUP_DETECTION.component, key: cleanupDetectionKey(source.mediaHash, 0.5), artifactId: sourceId, sourceHash: source.mediaHash,
        provenance: { analyzer: CLEANUP_DETECTION.component, version: 1, provider: null, model: 'PP-OCRv5_mobile_det', createdAt: new Date().toISOString() },
        value: { regions: [{ id: 'title', x: 0.1, y: 0.4, width: 0.8, height: 0.25, start: 0.5, end: 1.5 }], interval: 0.5, samples: 4 },
      })
    }
    await books.close()
    const port = await availablePort()
    origin = `http://127.0.0.1:${port}`
    const env = {
      ...process.env, ...Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, ''])), NODE_ENV: 'test', PORT: String(port),
      VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json'), VIDEOBOOK_ENV_PATH: join(root, 'empty.env'),
      VIDEOBOOK_OP_VAULT: '', VIDEOBOOK_OP_SERVICE_TOKEN: '', OP_SERVICE_ACCOUNT_TOKEN: '',
      VIDEOBOOK_CLEANUP_MODEL_DIR: REAL_MODELS ? process.env.VIDEOBOOK_CLEANUP_MODEL_DIR : join(root, 'models'),
    }
    await writeFile(env.VIDEOBOOK_ENV_PATH, '')
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'cleanup-ui', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    const vitePort = await availablePort(), appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(testBudget(30_000))
    page.setDefaultNavigationTimeout(testBudget(60_000))
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript((id) => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  }, testBudget(120_000))

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }, testBudget(30_000))

  it('reviews detected regions, draws and edits boxes, fits a phone, and renders a copy', async () => {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: testBudget(30_000) }).toBe(true)
    await input.fill('/remove-graphics @a1')
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await sheet().waitFor({ state: 'visible', timeout: testBudget(30_000) })
    await expect.poll(() => sheet().getByRole('button', { name: /^Region 1 / }).count(), { timeout: testBudget(60_000) }).toBe(1)
    await sheet().getByRole('button', { name: /^Region 1 / }).click()
    await sheet().getByLabel('Removal method').selectOption('fill')
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
      await page.setViewportSize(size)
      await expect.poll(async () => {
        const box = await sheet().locator('.cleanup-stage').boundingBox()
        return box ? Math.abs(box.width / box.height - 1.6) : 1
      }).toBeLessThan(0.02)
      expect(await sheet().locator('.video-cleanup-body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await sheet().locator('.cleanup-stage svg').scrollIntoViewIfNeeded()
    const stage = await sheet().locator('.cleanup-stage svg').boundingBox()
    if (!stage) throw new Error('Missing region canvas')
    await page.mouse.move(stage.x + stage.width * 0.05, stage.y + stage.height * 0.05)
    await page.mouse.down()
    await page.mouse.move(stage.x + stage.width * 0.2, stage.y + stage.height * 0.2, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => sheet().getByRole('button', { name: /^Region 2 / }).count()).toBe(1)
    await sheet().getByRole('button', { name: 'Delete region', exact: true }).click()
    await sheet().getByRole('button', { name: /^Region 1 / }).click()
    for (const [label, value] of [['Left (%)', '9'], ['Top (%)', '40'], ['Width (%)', '82'], ['Height (%)', '25'], ['From (s)', '0.5'], ['Until (s)', '1.5']]) await sheet().getByLabel(label!, { exact: true }).fill(value!)
    if (process.env.VIDEOBOOK_E2E_SHOTS) await page.screenshot({ path: join(process.env.VIDEOBOOK_E2E_SHOTS, 'video-cleanup-editor.png') })
    const sourceBefore = Buffer.from(await (await fetch(`${origin}/files/${bookId}/${sourceId}/original.mp4`)).arrayBuffer())
    await sheet().getByRole('button', { name: /^Remove into copy/ }).click()
    await sheet().waitFor({ state: 'hidden', timeout: testBudget(30_000) })
    let output = ''
    await expect.poll(async () => {
      const result = await call('get_notebook', { notebook_id: notebookId }) as { cells?: Array<{ output_artifact_id?: string; inputs?: Record<string, unknown> }> }
      output = result.cells?.find((cell) => cell.inputs?.sourceOperation === 'remove_video_graphics')?.output_artifact_id ?? ''
      return output
    }, { timeout: testBudget(60_000) }).not.toBe('')
    expect(output).not.toBe(sourceId)
    const cleaned = await fetch(`${origin}/files/${bookId}/${output}/original.mp4`)
    expect(cleaned.ok).toBe(true)
    const outputPath = join(root, 'cleaned.mp4')
    await writeFile(outputPath, Buffer.from(await cleaned.arrayBuffer()))
    expect(await probeVideo(outputPath)).toMatchObject({ width: 512, height: 320, fps: 6, hasAudio: false })
    const sourceAfter = Buffer.from(await (await fetch(`${origin}/files/${bookId}/${sourceId}/original.mp4`)).arrayBuffer())
    expect(sourceAfter.equals(sourceBefore)).toBe(true)
    expect(errors).toEqual([])
  }, testBudget(120_000))
})
