import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import sharp from 'sharp'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { XaiRealtimeEndpoint } from '../../server/src/tools/xai-realtime-endpoint.js'
import { availablePort, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness'
import type { StartedProcess } from './e2e-harness'

const execFileAsync = promisify(execFile)

async function until(predicate: () => Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Voice fullscreen fixture did not become ready')
}

describe('voice opens a cell fullscreen in the real browser', () => {
  let root: string
  let browser: Browser
  let page: Page
  let client: Client
  let bookId: string
  let notebookId: string
  let imageArtifactId: string
  let turns = 0
  const endpoint = new XaiRealtimeEndpoint()
  const processes: StartedProcess[] = []

  async function call<Result>(name: string, args: Record<string, unknown>): Promise<Result> {
    return resultValue(await client.callTool({ name, arguments: args })) as Result
  }

  async function uploadToCell(type: 'image' | 'audio', filename: string, data: Buffer, column: number) {
    const uploaded = await call<{ assetId: string }>('upload_file', { book_id: bookId, filename, data: data.toString('base64') })
    const listed = await call<{ assets: Array<{ id: string; artifact_id: string }> }>('list_assets', { book_id: bookId })
    const artifactId = listed.assets.find(asset => asset.id === uploaded.assetId)!.artifact_id
    await call('create_notebook_cell', {
      book_id: bookId, notebook_id: notebookId,
      cell: { type, slot: { row: 0, column }, label: `voice ${type}`, output_artifact_id: artifactId },
    })
    return artifactId
  }

  /** One spoken turn as the provider reports it, ending in the model's action. */
  function speak(transcript: string, assetId: string) {
    const turn = turns += 1
    const event = (type: string, extra: Record<string, unknown>) => endpoint.send({ type, event_id: `turn-${turn}-${type}`, ...extra })
    event('input_audio_buffer.speech_started', { item_id: `turn-${turn}` })
    event('input_audio_buffer.speech_stopped', {})
    event('conversation.item.input_audio_transcription.completed', { item_id: `turn-${turn}`, transcript })
    event('response.created', { response: { id: `response-${turn}` } })
    event('response.function_call_arguments.done', {
      response_id: `response-${turn}`, call_id: `call-${turn}`, name: 'prepare_workspace_action',
      arguments: JSON.stringify({ tool: 'show_media_fullscreen', params: { asset_id: assetId } }),
    })
    event('response.done', { response: { id: `response-${turn}`, status: 'completed' } })
    return `call-${turn}`
  }

  function actionOutput(callId: string): Record<string, unknown> | undefined {
    const item = endpoint.sent.find(sent => sent.type === 'conversation.item.create'
      && sent.item?.type === 'function_call_output' && sent.item.call_id === callId)?.item
    return item ? JSON.parse(String(item.output)) as Record<string, unknown> : undefined
  }

  async function startVoice() {
    await page.getByLabel('Start voice conversation').click()
    await expect.poll(() => page.locator('.composer-mode-switch [role="status"]').innerText(), { timeout: 20_000 }).toBe('Listening')
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-voice-fullscreen-'))
    await mkdir('test-results/voice', { recursive: true })
    const endpointUrl = await endpoint.listen()
    const serverUrl = `http://127.0.0.1:${await availablePort()}`
    const appUrl = `http://127.0.0.1:${await availablePort()}`
    const server = startProcess(['--import', 'tsx', 'server/src/index.ts'], {
      ...process.env, OPENAI_API_KEY: '', XAI_API_KEY: 'local-endpoint-key', VIDEOBOOK_XAI_REALTIME_URL: endpointUrl,
      PORT: new URL(serverUrl).port, VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json'),
    })
    processes.push(server)
    await waitForHttp(`${serverUrl}/healthz`, server, 200)
    client = new Client({ name: 'voice-fullscreen-test', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`)))
    await call('create_book', { name: 'voice-fullscreen' })
    bookId = (await call<Array<{ bookId: string }>>('list_books', {}))[0]!.bookId
    notebookId = (await call<Array<{ id: string }>>('list_notebooks', { book_id: bookId }))[0]!.id
    const image = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#39895a' } }).png().toBuffer()
    imageArtifactId = await uploadToCell('image', 'voice-image.png', image, 6)
    const silencePath = join(root, 'silence.wav')
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '5', silencePath])
    const vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', new URL(appUrl).port, '--strictPort'], {
      ...process.env, VIDEOBOOK_SERVER_URL: serverUrl, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
    })
    processes.push(vite)
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${silencePath}`] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ['microphone'] })
    await page.goto(appUrl)
    await page.getByLabel('Start voice conversation').waitFor({ state: 'visible', timeout: 30_000 })
    await until(() => page.getByLabel('Start voice conversation').isEnabled())
    await page.locator('.composer-mode-switch .composer-mode-cell-live').click()
    await page.getByRole('menuitemradio', { name: 'xAI', exact: true }).click()
  }, 120_000)

  afterAll(async () => {
    await Promise.race([browser?.close(), new Promise(resolve => setTimeout(resolve, 5000))])
    await client?.close().catch(() => undefined)
    await endpoint.close()
    for (const processState of processes.reverse()) await stopProcess(processState)
    if (root) await rm(root, { recursive: true, force: true })
  }, 60_000)

  afterEach(async ({ task }) => {
    if (task.result?.state !== 'fail' || !page || page.isClosed()) return
    const name = task.name.replaceAll(/[^a-z0-9]+/giu, '-').slice(0, 100)
    await page.screenshot({ path: `test-results/voice/fullscreen-failure-${name}.png` })
    await writeFile(`test-results/voice/fullscreen-failure-${name}.txt`, await page.locator('body').innerText())
  })

  it('shows the spoken cell fullscreen without a review and ends the voice channel', async () => {
    await startVoice()
    const callId = speak('Show me A7 full screen.', imageArtifactId)
    const viewer = page.getByRole('dialog', { name: 'Fullscreen preview for @a7' })
    await viewer.waitFor({ state: 'visible', timeout: 20_000 })
    expect(await viewer.getByLabel('Image with detected subject overlays').count()).toBe(1)
    expect(await page.locator('.confirm-sheet').count()).toBe(0)
    // Fullscreen is its own scope: the channel closes instead of listening on.
    await expect.poll(() => page.getByLabel('Start voice conversation').isDisabled()).toBe(true)
    expect(actionOutput(callId)?.status).not.toBe('failed')
    await page.screenshot({ path: 'test-results/voice/spoken-fullscreen.png' })
    await page.getByLabel('Close fullscreen preview').click()
    await viewer.waitFor({ state: 'hidden' })
    await expect.poll(() => page.getByLabel('Start voice conversation').isEnabled()).toBe(true)
    expect(await page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
  })

  it('answers a cell that holds audio with the reason and keeps listening', async () => {
    const tone = join(root, 'tone.wav')
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', tone])
    const audioArtifactId = await uploadToCell('audio', 'voice-tone.wav', await readFile(tone), 7)
    await startVoice()
    const callId = speak('Show me A8 full screen.', audioArtifactId)
    await expect.poll(() => actionOutput(callId), { timeout: 20_000 }).toMatchObject({
      status: 'failed',
      message: '@a8 holds audio; fullscreen shows images and video',
    })
    expect(await page.getByRole('dialog', { name: /Fullscreen preview/u }).count()).toBe(0)
    expect(await page.locator('.composer-mode-switch [role="status"]').innerText()).not.toBe('Off')
    await page.getByLabel('Stop voice conversation').click()
  })
})
