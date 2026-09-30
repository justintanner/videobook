import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { XaiRealtimeEndpoint } from '../../server/src/tools/xai-realtime-endpoint.js'

const execFileAsync = promisify(execFile)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate: () => Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return
    await delay(100)
  }
  throw new Error('Voice browser fixture did not become ready')
}

async function port() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

function result(value: unknown): Record<string, unknown> | unknown[] {
  const response = value as { isError?: boolean; content: Array<{ text?: string }> }
  if (response.isError) throw new Error(response.content[0]?.text)
  return JSON.parse(response.content[0]?.text ?? '{}') as Record<string, unknown> | unknown[]
}

const ACTIVATION_LINE = page =>
  page.locator('.voice-captions p[data-role="assistant"] .composer-history-text').filter({ hasText: /^Voice Chat Activated$/ })

function timingStages(page: Page) {
  return page.evaluate(() => performance.getEntriesByName('videobook-voice').map(entry => ((entry as PerformanceMark).detail as { stage: string }).stage))
}

describe('voice activation line in the real browser', () => {
  let root: string
  let appUrl: string
  let serverUrl: string
  let browser: Browser
  let page: Page
  const endpoint = new XaiRealtimeEndpoint()
  const children: ChildProcess[] = []
  const startupOutput: string[] = []

  function start(args: string[], env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => startupOutput.push(String(chunk)))
    child.stderr.on('data', chunk => startupOutput.push(String(chunk)))
    children.push(child)
  }

  beforeAll(async () => {
    const stage = (name: string) => console.error(`[activation-fixture] ${name}`)
    stage('root')
    root = await mkdtemp(join(tmpdir(), 'videobook-voice-activation-'))
    await mkdir('test-results/voice', { recursive: true })
    const endpointUrl = await endpoint.listen()
    stage('endpoint ' + endpointUrl)
    const serverPort = await port()
    const appPort = await port()
    serverUrl = `http://127.0.0.1:${serverPort}`
    appUrl = `http://127.0.0.1:${appPort}`
    start(['--import', 'tsx', 'server/src/index.ts'], {
      ...process.env, OPENAI_API_KEY: '', XAI_API_KEY: 'local-endpoint-key', VIDEOBOOK_XAI_REALTIME_URL: endpointUrl,
      PORT: String(serverPort), VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json'),
    })
    await waitFor(async () => (await fetch(`${serverUrl}/healthz`)).status === 200)
    stage('server healthy')
    const client = new Client({ name: 'voice-activation-test', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`)))
    stage('mcp connected')
    result(await client.callTool({ name: 'create_book', arguments: { name: 'voice-activation' } }))
    await client.close()
    stage('book created')
    start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { ...process.env, VIDEOBOOK_SERVER_URL: serverUrl, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' })
    await waitFor(async () => (await fetch(appUrl)).status === 200)
    stage('vite ready')
    const silencePath = join(root, 'silence.wav')
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '5', silencePath])
    stage('silence wav')
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${silencePath}`] })
    stage('chromium up')
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ['microphone'] })
    await page.goto(appUrl)
    await page.getByLabel('Start voice conversation').waitFor({ state: 'visible', timeout: 30_000 })
    await waitFor(() => page.getByLabel('Start voice conversation').isEnabled())
    stage('page ready')
    await page.locator('.composer-mode-switch .composer-mode-cell-live').click()
    await page.getByRole('menuitemradio', { name: 'xAI', exact: true }).click()
    stage('provider pinned')
  }, 120_000)

  afterAll(async () => {
    if (page && !page.isClosed() && await page.getByLabel('Stop voice conversation').count()) await page.getByLabel('Stop voice conversation').click().catch(() => undefined)
    await Promise.race([browser?.close(), delay(5000)])
    await endpoint.close()
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGINT')
      const finished = await Promise.race([exited.then(() => true), delay(5000).then(() => false)])
      if (!finished) { child.kill('SIGKILL'); await exited }
    }
    if (root) await rm(root, { recursive: true, force: true })
    if (startupOutput.length && process.env.VIDEOBOOK_VOICE_DEBUG === '1') console.log(startupOutput.join('\n'))
  }, 60_000)

  afterEach(async ({ task }) => {
    if (task.result?.state !== 'fail' || !page || page.isClosed()) return
    const name = task.name.replaceAll(/[^a-z0-9]+/giu, '-').slice(0, 100)
    await page.screenshot({ path: `test-results/voice/activation-failure-${name}.png` })
    await writeFile(`test-results/voice/activation-failure-${name}.txt`, await page.locator('body').innerText())
    await writeFile(`test-results/voice/activation-failure-${name}-timing.json`, JSON.stringify(await page.evaluate(() => performance.getEntriesByName('videobook-voice').map(entry => ({ at: entry.startTime, ...(entry as PerformanceMark).detail }))), null, 2))
  })

  it('greets with the activation line when the voice channel opens', async () => {
    await page.evaluate(() => performance.clearMarks('videobook-voice'))
    const composer = page.locator('.command-composer')
    let releaseConnection: () => void = () => undefined
    const connectionGate = new Promise<void>(resolve => { releaseConnection = resolve })
    await page.route('**/api/voice', async route => {
      await connectionGate
      await route.continue().catch(() => undefined)
    })
    try {
      await page.getByLabel('Start voice conversation').click()
      await expect.poll(() => page.getByLabel('Voice provider', { exact: true }).getAttribute('data-voice-phase')).toBe('connecting')
      expect(await composer.getAttribute('data-dock-open')).toBe('false')
    } finally {
      releaseConnection()
      await page.unroute('**/api/voice')
    }
    await expect.poll(async () => await ACTIVATION_LINE(page).count(), { timeout: 20_000 }).toBeGreaterThan(0)
    await expect.poll(async () => await ACTIVATION_LINE(page).first().textContent()).toBe('Voice Chat Activated')
    await expect.poll(() => composer.getAttribute('data-dock-open')).toBe('true')
    const stages = await timingStages(page)
    expect(stages).toContain('activation-audio')
    expect(stages).not.toContain('first-audio')
    expect(stages).not.toContain('utterance-end-to-decoded-audio')
    await expect.poll(() => page.locator('.composer-mode-switch [role="status"]').innerText()).toBe('Listening')
    expect(endpoint.forceMessageItems()).toHaveLength(1)
    expect(endpoint.sent.some(event => event.type === 'response.create')).toBe(false)
    expect(endpoint.sent.filter(event => event.type === 'conversation.item.create' && event.item?.type === 'function_call_output')).toHaveLength(0)
  })

  it('greets again after stop and start with one bubble per activation', async () => {
    await page.getByLabel('Stop voice conversation').click()
    await page.getByLabel('Start voice conversation').waitFor({ state: 'visible' })
    await waitFor(() => page.getByLabel('Start voice conversation').isEnabled())
    await page.getByLabel('Start voice conversation').click()
    await expect.poll(async () => await ACTIVATION_LINE(page).count(), { timeout: 20_000 }).toBe(2)
    expect(endpoint.forceMessageItems()).toHaveLength(2)
    expect(endpoint.sent.filter(event => event.type === 'session.update')).toHaveLength(2)
    await expect.poll(() => page.locator('.composer-mode-switch [role="status"]').innerText()).toBe('Listening')
  })

  it('treats the typed draft as toggleVoice does today and still greets', async () => {
    await page.getByLabel('Stop voice conversation').click()
    await page.getByLabel('Start voice conversation').waitFor({ state: 'visible' })
    await waitFor(() => page.getByLabel('Start voice conversation').isEnabled())
    const input = page.getByLabel('Videobook command input')
    await input.fill('Draft typed before voice')
    await page.getByLabel('Start voice conversation').click()
    await expect.poll(async () => await ACTIVATION_LINE(page).count(), { timeout: 20_000 }).toBe(3)
    expect(await input.textContent()).toBe('')
    expect(endpoint.forceMessageItems()).toHaveLength(3)
  })
})
