import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { WebSocket } from 'ws'
import { once } from 'node:events'
import sharp from 'sharp'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { summarizeVoiceMarks } from '../../src/videobook/voice-timeline'

const execFileAsync = promisify(execFile)
const live = process.env.VIDEOBOOK_RUN_VOICE_LIVE === '1'
const voiceMode = process.env.VIDEOBOOK_VOICE_TEST_MODE === 'xai' ? 'xai' : process.env.VIDEOBOOK_VOICE_TEST_MODE === 'openai' ? 'openai' : 'auto'
const benchmarkTurns = Math.max(1, Number(process.env.VIDEOBOOK_VOICE_BENCHMARK_TURNS ?? 1))
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const MCP_ROUNDTRIP_MS = 15_000

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


const PROVIDER_OPTION: Record<string, string> = { auto: 'Auto', openai: 'OpenAI', xai: 'xAI' }

describe('voice chat in the real browser', () => {
  let root: string
  let appUrl: string
  let serverUrl: string
  let browser: Browser
  let page: Page
  let client: Client
  let bookId: string
  const children: ChildProcess[] = []
  const startupOutput: string[] = []

  function liveModeCell() {
    return page.locator('.composer-mode-switch .composer-mode-cell-live')
  }

  async function assistantAfterLastUser(): Promise<boolean> {
    return page.evaluate(() => {
      const bubbles = [...document.querySelectorAll('.voice-captions p[data-role]')]
      let lastUser = -1
      bubbles.forEach((bubble, index) => { if (bubble.getAttribute('data-role') === 'user') lastUser = index })
      return bubbles.slice(lastUser + 1).some(bubble => bubble.getAttribute('data-role') === 'assistant')
    })
  }

  function activationTimelineProof() {
    return page.evaluate(() => {
      const marks = performance.getEntriesByName('videobook-voice').map(entry => ({ at: entry.startTime, stage: (entry as PerformanceMark).detail.stage as string }))
      const activation = marks.find(mark => mark.stage === 'activation-audio')
      const stop = marks.find(mark => mark.stage === 'speech-stop')
      return { hasActivation: Boolean(activation), beforeSpeechStop: Boolean(activation && stop && activation.at < stop.at) }
    })
  }

  async function selectVoiceProvider(mode: string) {
    await liveModeCell().click()
    await page.getByRole('menuitemradio', { name: PROVIDER_OPTION[mode], exact: true }).click()
  }

  // Voice off, the bar names the chat model, so the provider that is remembered
  // is read back from the engine menu rather than off the strip.
  async function checkedVoiceProvider(): Promise<string> {
    await liveModeCell().click()
    const checked = await page.getByRole('menuitemradio', { checked: true }).last().getAttribute('aria-label')
    await page.keyboard.press('Escape')
    return checked ?? ''
  }

  function start(args: string[], env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => startupOutput.push(String(chunk)))
    child.stderr.on('data', chunk => startupOutput.push(String(chunk)))
    children.push(child)
  }

  async function useRecording(name: string, leadingSilenceMs = 4000) {
    const speechPath = join(root, `${name}-microphone.wav`)
    await execFileAsync(FFMPEG, ['-y', '-i', resolve(`tests/fixtures/voice/${name}.wav`), '-af', `adelay=${leadingSilenceMs}:all=1,apad=pad_dur=60`, '-ar', '48000', '-ac', '1', speechPath])
    await openMicrophone(speechPath)
  }

  async function openMicrophone(speechPath: string) {
    await browser.close()
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${speechPath}`] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ['microphone'] })
    await page.goto(appUrl)
    await page.getByLabel('Start voice conversation').waitFor({ state: 'visible', timeout: 30_000 })
    await waitFor(() => page.getByLabel('Start voice conversation').isEnabled())
    await selectVoiceProvider(voiceMode)
  }

  async function ensureImage() {
    const notebooks = result(await client.callTool({ name: 'list_notebooks', arguments: { book_id: bookId } })) as Array<{ id: string; cells: Array<{ id: string; slot: { row: number; column: number } }> }>
    const existing = notebooks[0]!.cells.find(cell => cell.slot.row === 0 && cell.slot.column === 0)
    if (existing) return existing.id
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#39895a' } }).png().toBuffer()
    const uploaded = result(await client.callTool({ name: 'upload_file', arguments: { book_id: bookId, filename: 'voice-image.png', data: image.toString('base64') } })) as { assetId: string }
    const assets = result(await client.callTool({ name: 'list_assets', arguments: { book_id: bookId } })) as { assets: Array<{ id: string; artifact_id: string }> }
    const artifact = assets.assets.find(asset => asset.id === uploaded.assetId)!
    const cell = result(await client.callTool({ name: 'create_notebook_cell', arguments: { book_id: bookId, notebook_id: notebooks[0]!.id, cell: { type: 'image', slot: { row: 0, column: 0 }, label: 'voice image', output_artifact_id: artifact.artifact_id } } })) as { id: string }
    return cell.id
  }

  beforeAll(async () => {
    if (live && !process.env.OPENAI_API_KEY && !process.env.XAI_API_KEY) throw new Error('Live voice checks require an OpenAI or xAI API key and vitest.voice.config.ts')
    root = await mkdtemp(join(tmpdir(), 'videobook-voice-ui-'))
    await mkdir('test-results/voice', { recursive: true })
    const serverPort = await port()
    const appPort = await port()
    serverUrl = `http://127.0.0.1:${serverPort}`
    appUrl = `http://127.0.0.1:${appPort}`
    start(['--import', 'tsx', 'server/src/index.ts'], { ...process.env, OPENAI_API_KEY: live && process.env.VIDEOBOOK_VOICE_TEST_OPENAI_UNAVAILABLE !== '1' ? process.env.OPENAI_API_KEY : '', XAI_API_KEY: live ? process.env.XAI_API_KEY : '', PORT: String(serverPort), VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json') })
    await waitFor(async () => (await fetch(`${serverUrl}/healthz`)).status === 200)
    client = new Client({ name: 'voice-browser-test', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`)))
    result(await client.callTool({ name: 'create_book', arguments: { name: 'voice-comms' } }))
    const books = result(await client.callTool({ name: 'list_books', arguments: {} })) as Array<{ bookId: string }>
    bookId = books[0]!.bookId
    start(['node_modules/vite/bin/vite.js', ...(process.env.VIDEOBOOK_VOICE_TEST_PREVIEW === '1' ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { ...process.env, VIDEOBOOK_SERVER_URL: serverUrl, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' })
    await waitFor(async () => (await fetch(appUrl)).status === 200)
    const speechPath = join(root, 'microphone.wav')
    if (benchmarkTurns > 1) {
      const sources = ['ready', 'colors', 'storyboard', 'moon']
      const filters = sources.map((_, index) => `[${index}:a]apad=pad_dur=6[a${index}]`).join(';')
      await execFileAsync(FFMPEG, ['-y', ...sources.flatMap(name => ['-i', resolve(`tests/fixtures/voice/${name}.wav`)]), '-filter_complex', `${filters};[a0][a1][a2][a3]concat=n=4:v=0:a=1,adelay=4000:all=1[out]`, '-map', '[out]', '-ar', '48000', '-ac', '1', speechPath])
    } else await execFileAsync(FFMPEG, ['-y', '-i', resolve('tests/fixtures/voice/ready.wav'), '-af', 'adelay=4000:all=1,apad=pad_dur=7', '-ar', '48000', '-ac', '1', speechPath])
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${speechPath}`] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ['microphone'] })
    await page.goto(appUrl)
    await page.getByLabel('Videobook command input').waitFor({ state: 'visible', timeout: 30_000 })
    await waitFor(() => page.getByLabel('Start voice conversation').isEnabled())
    await selectVoiceProvider(voiceMode)
  }, 90_000)

  afterAll(async () => {
    if (page && !page.isClosed() && await page.getByLabel('Stop voice conversation').count()) await page.getByLabel('Stop voice conversation').click().catch(() => undefined)
    await Promise.race([browser?.close(), delay(5000)])
    await Promise.race([client?.close(), delay(5000)])
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGINT')
      const finished = await Promise.race([exited.then(() => true), delay(5000).then(() => false)])
      if (!finished) { child.kill('SIGKILL'); await exited }
    }
    if (root) await rm(root, { recursive: true, force: true })
  }, 60_000)

  afterEach(async ({ task }) => {
    if (task.result?.state !== 'fail' || !page || page.isClosed()) return
    const name = task.name.replaceAll(/[^a-z0-9]+/giu, '-').slice(0, 100)
    await page.screenshot({ path: `test-results/voice/failure-${name}.png` })
    await writeFile(`test-results/voice/failure-${name}.txt`, await page.locator('body').innerText())
    await writeFile(`test-results/voice/failure-${name}-timing.json`, JSON.stringify(await page.evaluate(() => performance.getEntriesByName('videobook-voice').map(entry => ({ at: entry.startTime, ...(entry as PerformanceMark).detail }))), null, 2))
  })

  it('keeps the toggle keyboard accessible and fits desktop, phone and short landscape', async () => {
    const input = page.getByLabel('Videobook command input')
    await input.fill('Keep this typed draft')
    const toggle = page.getByLabel('Start voice conversation')
    const model = page.getByLabel('Chat model', { exact: true })
    await model.focus()
    await expect.poll(() => model.evaluate(el => el === document.activeElement)).toBe(true)
    await toggle.focus()
    await expect.poll(() => toggle.evaluate(el => el === document.activeElement)).toBe(true)
    expect(await toggle.getAttribute('aria-pressed')).toBe('false')
    // Voice off: the strip is the lit model cell plus the idle microphone, and
    // the provider is one click away inside that cell's menu.
    expect(await page.locator('.composer-mode-switch .composer-mode-cell-live').getAttribute('aria-label')).toBe('Chat model')
    expect(await page.locator('.composer-mode-switch .composer-mode-cell-idle').getAttribute('aria-label')).toBe('Start voice conversation')
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 640 }, { width: 640, height: 320 }]) {
      await page.setViewportSize(viewport)
      const bounds = await toggle.boundingBox()
      const actions = await page.locator('.command-actions-toggle').boundingBox()
      expect(bounds).not.toBeNull()
      // The composer row sits on one tier: every cell matches the actions
      // button rather than standing 44px tall beside 32px neighbours.
      expect(bounds!.height).toBe(actions!.height)
      expect(bounds!.width).toBe(actions!.width)
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
      expect(await page.getByLabel('Send command').isVisible()).toBe(true)
      expect(await page.getByLabel('Chat model').isVisible()).toBe(true)
      expect(await page.getByLabel('Send command').boundingBox()).toMatchObject({ height: actions!.height })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(1)
      const modelBounds = await model.boundingBox()
      expect(modelBounds!.height).toBe(actions!.height)
      expect(modelBounds!.x).toBeGreaterThanOrEqual(0)
      expect(modelBounds!.x + modelBounds!.width).toBeLessThanOrEqual(viewport.width)
      const controls = await page.locator('.command-actions-controls, .composer-mode-switch, .command-send').evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect()
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
      }))
      for (const [index, box] of controls.entries()) {
        expect(box.left).toBeGreaterThanOrEqual(-1)
        expect(box.right).toBeLessThanOrEqual(viewport.width + 1)
        for (const other of controls.slice(index + 1)) expect(box.right <= other.left + 1 || other.right <= box.left + 1 || box.bottom <= other.top + 1 || other.bottom <= box.top + 1).toBe(true)
      }
      await page.screenshot({ path: `test-results/voice/off-${viewport.width}.png` })
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await mkdir('test-results/voice', { recursive: true })
    await page.screenshot({ path: 'test-results/voice/off.png' })
    expect(await input.innerText()).toBe('Keep this typed draft')
  })

  it('remembers the provider selection without starting the microphone', async () => {
    await selectVoiceProvider('xai')
    expect(await page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    await page.reload()
    await waitFor(() => page.getByLabel('Start voice conversation').isEnabled())
    expect(await checkedVoiceProvider()).toBe('xAI')
    expect(await page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    expect(await page.locator('.chat-voice-activity').count()).toBe(0)
    await selectVoiceProvider(voiceMode)
  })

  it.skipIf(live)('recovers from a missing key with a cleared draft and never restarts on reload', async () => {
    await page.getByLabel('Videobook command input').fill('Keep this typed draft')
    await page.evaluate(() => performance.clearMarks('videobook-voice'))
    for (const mode of ['openai', 'xai', 'auto']) {
      await selectVoiceProvider(mode)
      await page.getByLabel('Start voice conversation').click()
      await page.getByRole('alert').waitFor({ state: 'visible', timeout: 15_000 })
      const failure = await page.getByLabel('Voice activity').innerText()
      if (mode !== 'xai') expect(failure).toContain('OPENAI_API_KEY')
      if (mode !== 'openai') expect(failure).toContain('XAI_API_KEY')
      if (mode === 'openai') expect(failure).not.toContain('XAI_API_KEY')
      if (mode === 'xai') expect(failure).not.toContain('OPENAI_API_KEY')
    }
    const marks = await page.evaluate(() => performance.getEntriesByName('videobook-voice').map(entry => ({
      at: entry.startTime,
      ...((entry as PerformanceMark).detail as { stage: string; durationMs?: number }),
    })))
    const stages = marks.map(mark => mark.stage)
    expect(stages).toEqual(expect.arrayContaining([
      'connect-start',
      'permission-wait-start',
      'permission-wait-end',
      'session-request',
    ]))
    expect(await page.getByLabel('Videobook command input').textContent()).toBe('')
    expect(await page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    await page.screenshot({ path: 'test-results/voice/error.png' })
    await page.reload()
    await page.getByLabel('Start voice conversation').waitFor({ state: 'visible' })
    expect(await page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    expect(await page.locator('.chat-voice-activity').count()).toBe(0)
  })

  it.skipIf(live)('shows captions without a toggle, submitting, or losing the draft', async () => {
    const input = page.getByLabel('Videobook command input')
    await page.getByLabel('Start voice conversation').click()
    await page.getByLabel('Voice activity').waitFor({ state: 'visible', timeout: 15_000 })
    await input.fill('Captions stay with this draft')
    const captions = page.locator('.voice-captions')
    expect(await captions.isVisible()).toBe(true)
    expect(await page.locator('.voice-captions-toggle').count()).toBe(0)
    expect(await captions.getAttribute('id')).toBeTruthy()
    expect(await captions.innerText()).toMatch(/OPENAI_API_KEY|XAI_API_KEY/)
    await page.keyboard.press('Escape')
    await expect.poll(() => captions.isVisible()).toBe(false)
    expect(await input.innerText()).toBe('Captions stay with this draft')
    expect(await page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    expect(await page.locator('.confirm-sheet').count()).toBe(0)
    await page.screenshot({ path: 'test-results/voice/captions-shown.png' })
  })

  it('keeps voice connection compact through microphone permission and rapid start/stop', async () => {
    const devtools = await page.context().newCDPSession(page)
    const { targetInfo } = await devtools.send('Target.getTargetInfo')
    const permission = { permission: { name: 'microphone' }, origin: appUrl, browserContextId: targetInfo.browserContextId }
    await devtools.send('Browser.setPermission', { ...permission, setting: 'granted' })
    const input = page.getByLabel('Videobook command input')
    const composer = page.locator('.command-composer')
    let releaseConnection: () => void = () => undefined
    const connectionGate = new Promise<void>(resolve => { releaseConnection = resolve })
    await page.route('**/api/voice', async route => {
      await connectionGate
      await route.continue().catch(() => undefined)
    })
    try {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
        await page.setViewportSize(viewport)
        if (await composer.getAttribute('data-dock-open') === 'true') await page.getByLabel('Collapse chat', { exact: true }).click()
        await input.fill('Previous voice draft')
        const before = await composer.boundingBox()
        const inputBefore = await input.boundingBox()
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await page.getByLabel('Start voice conversation').click()
        const provider = page.getByLabel('Voice provider', { exact: true })
        await expect.poll(() => provider.getAttribute('data-voice-phase'), { timeout: MCP_ROUNDTRIP_MS }).toBe('connecting')
        await expect.poll(() => page.locator('.composer-mode-switch [role="status"]').innerText(), { timeout: MCP_ROUNDTRIP_MS }).toBe('Connecting voice')
        expect(await composer.getAttribute('data-dock-open')).toBe('false')
        expect(await page.getByLabel('Voice activity').isVisible()).toBe(false)
        expect(await composer.boundingBox()).toEqual(before)
        expect((await input.boundingBox())?.height).toBe(inputBefore?.height)
        expect(await composer.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
        const spinner = provider.locator('.composer-mode-connecting')
        expect(await spinner.evaluate(element => getComputedStyle(element).animationName)).toBe('composer-mode-connect-spin')
        await page.screenshot({ path: `test-results/voice/connecting-${viewport.width}.png` })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        expect(await spinner.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
        await page.getByLabel('Stop voice conversation').click()
        expect(await input.textContent()).toBe('')
      }
    } finally {
      releaseConnection()
      await page.unroute('**/api/voice')
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await input.fill('Permission recovery draft')
    await devtools.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'denied', origin: appUrl, browserContextId: targetInfo.browserContextId })
    await page.getByLabel('Start voice conversation').click()
    await expect.poll(() => page.getByLabel('Voice activity').innerText(), { timeout: 10_000 }).toContain('Microphone access is blocked')
    expect(await page.getByLabel('Videobook command input').textContent()).toBe('')
    await devtools.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'granted', origin: appUrl, browserContextId: targetInfo.browserContextId })
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await page.getByLabel('Start voice conversation').click()
      await page.getByLabel('Stop voice conversation').click()
      expect(await page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    }
    expect(await page.getByLabel('Videobook command input').textContent()).toBe('')
    await devtools.detach()
  })

  it.skipIf(!live)('captures real microphone audio, decodes a spoken response, captions and history, then stops', async () => {
    await openMicrophone(join(root, 'microphone.wav'))
    await page.evaluate(() => performance.clearMarks('videobook-voice'))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const negotiation = page.waitForResponse(response => response.url().endsWith('/api/voice') && response.request().method() === 'POST')
    await page.getByLabel('Start voice conversation').click()
    await page.getByLabel('Videobook command input').fill('Keep this typed draft')
    const response = await negotiation
    const sent = response.request().postDataJSON() as { mode?: string; sampleRate?: number; bookId?: string; notebookId?: string; sdp?: string }
    expect(sent.sampleRate).toBe(48_000)
    expect(response.status(), JSON.stringify({ mode: sent.mode, sampleRate: sent.sampleRate, bookId: sent.bookId, notebookId: sent.notebookId, sdpLength: sent.sdp?.length, sdpPrefix: sent.sdp?.slice(0, 8) })).toBe(201)
    const connected = await response.json() as { provider: string; fallbackReason?: string }
    if (voiceMode !== 'auto') expect(connected.provider).toBe(voiceMode)
    if (voiceMode === 'auto' && connected.provider === 'xai') {
      expect(connected.fallbackReason).toBeTruthy()
      await page.locator('.voice-fallback').waitFor({ state: 'visible' })
    } else expect(connected.fallbackReason).toBeUndefined()
    await expect.poll(() => page.locator('.composer-mode-switch').innerText(), { timeout: MCP_ROUNDTRIP_MS }).toContain(connected.provider === 'xai' ? 'xAI' : 'OpenAI')
    await expect.poll(async () => await page.locator('.voice-captions p[data-role="assistant"] .composer-history-text').first().textContent(), { timeout: 15_000 }).toBe('Voice Chat Activated')
    await expect.poll(assistantAfterLastUser, { timeout: 35_000 }).toBe(true)
    await expect.poll(async () => (await activationTimelineProof()).beforeSpeechStop, { timeout: 15_000 }).toBe(true)
    const timing = () => page.evaluate(() => performance.getEntriesByName('videobook-voice').map(entry => ({ at: entry.startTime, ...((entry as PerformanceMark).detail as { stage: string; model?: string; role?: string; microphoneSignalEndedAt?: number }) })))
    try {
      await expect.poll(async () => (await timing()).filter(entry => entry.stage === 'first-audio').length, { timeout: benchmarkTurns * 15_000 + 20_000 }).toBeGreaterThanOrEqual(benchmarkTurns)
    } finally {
      await writeFile('test-results/voice/live-debug.json', JSON.stringify({ timing: await timing(), text: await page.locator('.command-composer').innerText() }, null, 2))
      await page.screenshot({ path: 'test-results/voice/live-debug.png' })
    }
    expect(await page.getByLabel('Videobook command input').innerText()).toBe('Keep this typed draft')
    const history = result(await client.callTool({ name: 'list_prompt_history', arguments: { book_id: bookId, surface: 'chat' } }))
    expect(JSON.stringify(history).toLowerCase()).toContain('ready')
    expect(JSON.stringify(history).toLowerCase()).not.toContain('voice chat activated')
    await page.screenshot({ path: 'test-results/voice/live.png' })
    await writeFile('test-results/voice/live-timing.json', JSON.stringify(await timing(), null, 2))
    const marks = await timing()
    const summary = summarizeVoiceMarks(marks)
    expect(summary.connectionSetupMs).toBeGreaterThan(0)
    expect(summary.permissionWaitMs).toBeGreaterThanOrEqual(0)
    expect(summary.utteranceEndToDecodedAudioMs.length).toBeGreaterThan(0)
    const finals = await page.locator('.voice-captions p[data-role="assistant"][data-final="true"] .composer-history-text').allTextContents()
    const replies = finals.map(text => text.trim()).filter(text => text && text !== 'Voice Chat Activated')
    expect(replies.length).toBeGreaterThan(0)
    for (const reply of replies) {
      expect(reply.split(/\s+/u).length).toBeLessThanOrEqual(20)
      expect(reply.toLowerCase()).not.toMatch(/\b(sorry|apologi[sz]e|sure,|got it|let me|as an ai)\b/u)
    }
    expect(marks.some(mark => mark.stage === 'media-ready')).toBe(true)
    expect(marks.some(mark => mark.stage === 'turn-detection')).toBe(true)
    expect(marks.some(mark => mark.stage === 'connection-setup')).toBe(true)
    expect(marks.some(mark => mark.stage === 'utterance-end-to-decoded-audio')).toBe(true)
    const latencies: number[] = []
    const microphoneLatencies: number[] = []
    const firstCaptionLatencies: number[] = []
    const finalCaptionLatencies: number[] = []
    let speechStop: number | null = null
    let microphoneEnd: number | null = null
    let captionTurn: number | null = null
    for (const mark of marks) {
      if (mark.stage === 'speech-stop') { speechStop = mark.at; captionTurn = mark.at; microphoneEnd = mark.microphoneSignalEndedAt ?? null }
      if (mark.role === 'assistant' && captionTurn !== null) {
        if (mark.stage === 'caption-first') firstCaptionLatencies.push(mark.at - captionTurn)
        if (mark.stage === 'caption-final') { finalCaptionLatencies.push(mark.at - captionTurn); captionTurn = null }
      }
      if (mark.stage === 'first-audio' && speechStop !== null) {
        latencies.push(mark.at - speechStop)
        if (microphoneEnd) microphoneLatencies.push(mark.at - microphoneEnd)
        speechStop = null
      }
    }
    const sorted = [...latencies].sort((a, b) => a - b)
    const distribution = (values: number[]) => {
      const ordered = [...values].sort((a, b) => a - b)
      return { samples: values.length, p50Ms: ordered[Math.floor(ordered.length * .5)], p95Ms: ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * .95) - 1)] }
    }
    const model = marks.find(mark => mark.model)?.model ?? 'unknown'
    const report = {
      model, measuredAt: new Date().toISOString(), browser: await browser.version(),
      transport: `${model.startsWith('grok-') ? 'PCM over local WebSocket and HTTP stream' : 'WebRTC'} through local Videobook server; unthrottled connection; synthesized microphone recordings`,
      vad: { type: 'server_vad', threshold: .5, silenceMs: 350, prefixMs: 300 }, reasoning: model.startsWith('grok-') ? 'none' : 'minimal',
      sampleCount: latencies.length, p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)],
      connectMs: marks.find(mark => mark.stage === 'connected')!.at - marks.find(mark => mark.stage === 'connect-start')!.at,
      connectionSetupMs: summary.connectionSetupMs,
      permissionWaitMs: summary.permissionWaitMs,
      utteranceEndToDecodedAudio: summary.utteranceEndToDecodedAudio,
      microphoneToAudio: distribution(microphoneLatencies), firstCaption: distribution(firstCaptionLatencies), finalCaption: distribution(finalCaptionLatencies),
      latenciesMs: latencies, microphoneLatenciesMs: microphoneLatencies, marks,
    }
    await writeFile(`test-results/voice/benchmark-${model}-${benchmarkTurns}turns.json`, JSON.stringify(report, null, 2))
    await page.getByLabel('Stop voice conversation').click()
    await expect.poll(() => page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    expect((await timing()).some(entry => entry.stage === 'stopped')).toBe(true)
    const output = startupOutput.join('')
    expect(output).not.toContain('Unhandled')
  })

  it.skipIf(!live || process.env.VIDEOBOOK_VOICE_TEST_OPENAI_UNAVAILABLE !== '1')('cancels Auto during xAI fallback without reviving capture or retaining a session', async () => {
    await useRecording('ready')
    await selectVoiceProvider('auto')
    await page.getByLabel('Videobook command input').fill('Keep the cancelled connection draft')
    await page.evaluate(() => performance.clearMarks('videobook-voice'))
    const starts: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/voice')) starts.push(request.url()) })
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const requested = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/voice'))
      await page.getByLabel('Start voice conversation').click()
      await requested
      await delay(100)
      await page.getByLabel('Stop voice conversation').click()
      await delay(300)
    }
    await delay(1000)
    expect(starts).toHaveLength(5)
    expect(await page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    const releases = await page.evaluate(() => performance.getEntriesByName('videobook-voice').filter(entry => (entry as PerformanceMark).detail.stage === 'microphone-released').map(entry => (entry as PerformanceMark).detail.ended))
    expect(releases).toHaveLength(5)
    expect(releases.every(Boolean)).toBe(true)
    const negotiation = page.waitForResponse(response => response.url().endsWith('/api/voice') && response.request().method() === 'POST')
    await page.getByLabel('Start voice conversation').click()
    const response = await negotiation
    expect(response.status()).toBe(201)
    const session = await response.json() as { provider: string; fallbackReason: string }
    expect(session.provider).toBe('xai')
    expect(session.fallbackReason).toContain('OPENAI_API_KEY')
    await expect.poll(() => page.locator('.composer-mode-switch [role="status"]').innerText(), { timeout: 15_000 }).toBe('Listening')
    await page.getByLabel('Stop voice conversation').click()
    expect(await page.getByLabel('Videobook command input').textContent()).toBe('')
  })

  it.skipIf(!live)('routes a spoken mutation through Apply, preserves the draft and speaks the actual outcome', async () => {
    await ensureImage()
    await useRecording('rename')
    const chatCalls: unknown[] = []
    page.on('request', request => {
      if (!request.url().endsWith('/mcp') || request.method() !== 'POST') return
      const value = request.postDataJSON() as { params?: { name?: string } }
      if (value.params?.name === 'chat') chatCalls.push(value)
    })
    const input = page.getByLabel('Videobook command input')
    const negotiated = page.waitForResponse(response => response.url().endsWith('/api/voice') && response.request().method() === 'POST')
    await page.getByLabel('Start voice conversation').click()
    await input.fill('Keep my unfinished @a1 note')
    const session = await (await negotiated).json() as { id: string; token: string; provider: string }
    expect((await page.request.get(`${serverUrl}/api/voice/${session.id}/events`, { headers: { Authorization: 'Bearer wrong-owner' } })).status()).toBe(404)
    expect((await page.request.delete(`${serverUrl}/api/voice/${session.id}`, { headers: { Authorization: 'Bearer wrong-owner' } })).status()).toBe(404)
    expect((await page.request.post(`${serverUrl}/api/voice/${session.id}/outcome`, { headers: { Authorization: `Bearer ${session.token}` }, data: { callId: 'unknown-action', outcome: { status: 'completed', message: 'Unknown action' } } })).status()).toBe(409)
    await page.locator('.confirm-sheet').waitFor({ state: 'visible', timeout: 45_000 })
    if (session.provider === 'xai') {
      for (const token of ['x'.repeat(64), session.token]) {
        const socket = new WebSocket(`${serverUrl.replace('http:', 'ws:')}/api/voice/${session.id}/audio`, { origin: appUrl })
        const closed = once(socket, 'close')
        await once(socket, 'open')
        socket.send(JSON.stringify({ type: 'authenticate', token }))
        expect((await closed)[0]).toBe(1008)
      }
      expect(await page.getByLabel('Stop voice conversation').count()).toBe(1)
    }
    expect(await input.textContent()).toBe('Keep my unfinished @a1 note')
    expect(chatCalls).toHaveLength(0)
    const before = result(await client.callTool({ name: 'list_assets', arguments: { book_id: bookId } }))
    expect(JSON.stringify(before)).not.toContain('"label":"cover"')
    await page.screenshot({ path: 'test-results/voice/review.png' })
    const reviewMarks = await page.evaluate(() => performance.getEntriesByName('videobook-voice').map(entry => ({ at: entry.startTime, ...((entry as PerformanceMark).detail as { stage: string }) })))
    const review = reviewMarks.find(mark => mark.stage === 'action-review')
    const stop = reviewMarks.find(mark => mark.stage === 'speech-stop')
    await writeFile('test-results/voice/review-timing.json', JSON.stringify({ detectedTurnToReviewMs: review && stop ? review.at - stop.at : null }, null, 2))
    const completion = page.waitForResponse(response => response.url().endsWith(`/api/voice/${session.id}/outcome`) && (response.request().postDataJSON() as { outcome?: { status?: string } }).outcome?.status === 'completed')
    await page.locator('.confirm-sheet-apply').click()
    expect((await completion).status()).toBe(204)
    await expect.poll(async () => JSON.stringify(result(await client.callTool({ name: 'list_assets', arguments: { book_id: bookId } }))), { timeout: 15_000 }).toContain('cover')
    expect(await input.textContent()).toBe('Keep my unfinished @a1 note')
    expect(chatCalls).toHaveLength(1)
    await expect.poll(() => page.locator('.voice-captions').textContent(), { timeout: 20_000 }).toMatch(/renamed|updated|changed|labeled|labelled|done/i)
    const captionText = await page.locator('.voice-captions').textContent()
    expect(await page.locator('.confirm-sheet').count()).toBe(0)
    expect(await page.locator('.voice-captions').textContent()).toBe(captionText)
    await page.getByLabel('Stop voice conversation').click()
  })

  it.skipIf(!live)('applies the review on screen when the speaker approves it, without touching the draft', async () => {
    await ensureImage()
    await useRecording('review')
    const input = page.getByLabel('Videobook command input')
    const negotiated = page.waitForResponse(response => response.url().endsWith('/api/voice') && response.request().method() === 'POST')
    await page.getByLabel('Start voice conversation').click()
    await input.fill('Retain this @a1 draft')
    const session = await (await negotiated).json() as { id: string }
    await page.locator('.confirm-sheet').waitFor({ state: 'visible', timeout: 45_000 })
    // The recording asks for the rename, waits, then says "Yes, apply that
    // change". Approval reaches the same command the on-screen button runs.
    const applied = page.waitForResponse(response => response.url().endsWith(`/api/voice/${session.id}/outcome`)
      && ['completed', 'queued'].includes((response.request().postDataJSON() as { outcome?: { status?: string } }).outcome?.status ?? ''), { timeout: 60_000 })
    await expect.poll(() => page.locator('.voice-captions').innerText(), { timeout: 40_000 }).toMatch(/yes.*apply/i)
    expect((await applied).status()).toBe(204)
    await page.locator('.confirm-sheet').waitFor({ state: 'hidden', timeout: 20_000 })
    // The review clearing hands the mic back: the phase must leave 'review'
    // instead of parking there or dropping the session.
    await expect.poll(
      () => page.locator('.command-composer').getAttribute('data-voice-phase'),
      { timeout: 20_000 },
    ).not.toBe('review')
    expect(await page.locator('.command-composer').getAttribute('data-voice-phase')).not.toBe('off')
    expect(await input.textContent()).toBe('Retain this @a1 draft')
    await expect.poll(() => page.locator('.voice-captions p[data-role="assistant"]').last().innerText(), { timeout: 20_000 }).toMatch(/renamed|updated|changed|labeled|labelled|applied|done/i)
    await page.getByLabel('Stop voice conversation').click()
  })

  it.skipIf(!live)('reads real assets and auto-applies a spoken duplicate through the existing command route', async () => {
    await ensureImage()
    await useRecording('assets')
    await page.getByLabel('Start voice conversation').click()
    await expect.poll(() => page.locator('.voice-captions p[data-role="assistant"]').last().textContent(), { timeout: 40_000 }).toMatch(/image|asset/i)
    expect(await page.locator('.confirm-sheet').count()).toBe(0)
    await page.getByLabel('Stop voice conversation').click()
    const before = result(await client.callTool({ name: 'list_assets', arguments: { book_id: bookId } })) as { assets: unknown[] }
    await useRecording('duplicate')
    await page.getByLabel('Start voice conversation').click()
    const spokenBefore = await page.evaluate(() => performance.getEntriesByName('videobook-voice').filter(entry => (entry as PerformanceMark).detail.stage === 'first-audio').length)
    await expect.poll(async () => (result(await client.callTool({ name: 'list_assets', arguments: { book_id: bookId } })) as { assets: unknown[] }).assets.length, { timeout: 45_000 }).toBe(before.assets.length + 1)
    expect(await page.locator('.confirm-sheet').count()).toBe(0)
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('videobook-voice').filter(entry => (entry as PerformanceMark).detail.stage === 'first-audio').length), { timeout: 20_000 }).toBeGreaterThan(spokenBefore)
    await page.getByLabel('Stop voice conversation').click()
  })

  it.skipIf(!live)('opens the normal paid generation review, keeps it reachable at every width, and retains Cancel after switching provider', async () => {
    await useRecording('generate')
    const before = result(await client.callTool({ name: 'list_jobs', arguments: { book_id: bookId } }))
    await page.getByLabel('Start voice conversation').click()
    await page.locator('.confirm-sheet').waitFor({ state: 'visible', timeout: 45_000 })
    expect(await page.locator('.confirm-sheet').innerText()).toMatch(/generat|cost|provider/i)
    expect(result(await client.callTool({ name: 'list_jobs', arguments: { book_id: bookId } }))).toEqual(before)
    // A generation review parks until someone decides, so it is where the
    // sheet's own reachability is worth measuring.
    for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 640, height: 320 }, { width: 1440, height: 1000 }]) {
      await page.setViewportSize(viewport)
      const toggle = page.getByLabel('Stop voice conversation')
      const box = await toggle.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
      expect(await page.locator('.confirm-sheet-apply').isVisible()).toBe(true)
      expect(await page.getByRole('button', { name: /Cancel/ }).first().isVisible()).toBe(true)
      expect((await page.locator('.confirm-sheet-head').boundingBox())!.y).toBeGreaterThanOrEqual(0)
      const applyBox = await page.locator('.confirm-sheet-apply').boundingBox()
      expect(applyBox!.y).toBeGreaterThanOrEqual(0)
      expect(applyBox!.y + applyBox!.height).toBeLessThanOrEqual(viewport.height)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: `test-results/voice/review-${viewport.width}.png` })
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const requests: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/voice')) requests.push(request.url()) })
    await selectVoiceProvider(voiceMode === 'openai' ? 'xai' : 'openai')
    await expect.poll(() => page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    await delay(500)
    expect(requests).toHaveLength(0)
    expect(await page.locator('.confirm-sheet').isVisible()).toBe(true)
    await page.locator('.confirm-sheet').getByRole('button', { name: /Cancel/ }).click()
    await page.locator('.confirm-sheet').waitFor({ state: 'hidden' })
    expect(result(await client.callTool({ name: 'list_jobs', arguments: { book_id: bookId } }))).toEqual(before)
  })

  it.skipIf(!live)('answers a spoken video request using A1 with audio and a generation review', async () => {
    await ensureImage()
    await useRecording('generate-video', 10_000)
    const before = result(await client.callTool({ name: 'list_jobs', arguments: { book_id: bookId } }))
    await page.getByLabel('Start voice conversation').click()
    await expect.poll(() => page.locator('.voice-captions p[data-role="user"][data-final="true"]').first().innerText(), { timeout: 30_000 }).toMatch(/Make me a video with A\s?(?:1|one)/i)
    await expect.poll(assistantAfterLastUser, { timeout: 30_000 }).toBe(true)
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('videobook-voice').filter(entry => (entry as PerformanceMark).detail.stage === 'first-audio').length), { timeout: 15_000 }).toBeGreaterThan(0)
    await page.locator('.confirm-sheet').waitFor({ state: 'visible', timeout: 30_000 })
    expect(await page.locator('.confirm-sheet').innerText()).toMatch(/generat|cost|provider/i)
    await expect.poll(() => page.locator('.voice-captions p[data-role="assistant"][data-final="true"]').last().innerText(), { timeout: 30_000 }).toMatch(/apply|review|cancel/i)
    await expect.poll(() => page.evaluate(() => {
      const marks = performance.getEntriesByName('videobook-voice') as PerformanceMark[]
      const review = marks.find(entry => entry.detail.stage === 'action-review')
      return marks.some(entry => entry.detail.stage === 'first-audio' && review && entry.startTime > review.startTime)
    }), { timeout: 15_000 }).toBe(true)
    expect(await page.locator('.confirm-sheet').innerText()).toContain('@a1')
    expect(await page.locator('.confirm-sheet .generation-review-source').allTextContents()).toEqual([expect.stringContaining('@a1')])
    expect(await page.locator('.confirm-sheet').innerText()).toMatch(/seedance/i)
    expect(result(await client.callTool({ name: 'list_jobs', arguments: { book_id: bookId } }))).toEqual(before)
    await page.screenshot({ path: 'test-results/voice/video-request-review.png' })
    await page.locator('.confirm-sheet').getByRole('button', { name: /Cancel/ }).click()
    await page.getByLabel('Stop voice conversation').click()
  })

  it.skipIf(!live)('releases capture on native permission revocation and fullscreen scope changes', async () => {
    const cellId = await ensureImage()
    await useRecording('ready')
    await page.getByLabel('Start voice conversation').click()
    await expect.poll(() => page.locator('.composer-mode-switch [role="status"]').innerText(), { timeout: 15_000 }).toBe('Listening')
    const devtools = await page.context().newCDPSession(page)
    const { targetInfo } = await devtools.send('Target.getTargetInfo')
    await devtools.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'denied', origin: appUrl, browserContextId: targetInfo.browserContextId })
    await expect.poll(() => page.getByLabel('Voice activity').innerText(), { timeout: 10_000 }).toContain('Microphone disconnected')
    await devtools.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'granted', origin: appUrl, browserContextId: targetInfo.browserContextId })
    await page.getByLabel('Start voice conversation').click()
    await page.locator(`.react-flow__node[data-id="${cellId}"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open media', exact: true }).click()
    await page.getByLabel('Close fullscreen preview').waitFor({ state: 'visible' })
    expect(await page.getByLabel('Start voice conversation').isDisabled()).toBe(true)
    await page.screenshot({ path: 'test-results/voice/fullscreen.png' })
    await page.getByLabel('Close fullscreen preview').click()
    await waitFor(() => page.getByLabel('Start voice conversation').isEnabled())
    expect(await page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    await devtools.detach()
  })

  it.skipIf(!live)('silences actual decoded output when the user interrupts', async () => {
    await useRecording('interrupt')
    await page.getByLabel('Start voice conversation').click()
    const timings = () => page.evaluate(() => performance.getEntriesByName('videobook-voice').map(entry => ({ at: entry.startTime, ...((entry as PerformanceMark).detail as { stage: string }) })))
    await expect.poll(async () => (await timings()).some(mark => mark.stage === 'local-silence'), { timeout: 35_000 }).toBe(true)
    const marks = await timings()
    const barge = marks.find(mark => mark.stage === 'barge-in')!
    const silence = marks.find(mark => mark.stage === 'local-silence')!
    expect(silence.at - barge.at).toBeLessThanOrEqual(250)
    await expect.poll(() => page.locator('.voice-captions em').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await writeFile('test-results/voice/interruption.json', JSON.stringify({ delayMs: silence.at - barge.at, marks }, null, 2))
    await page.getByLabel('Stop voice conversation').click()
  })

  it.skipIf(!live)('stops on offline and project changes and requires explicit restart', async () => {
    await useRecording('ready')
    await page.getByLabel('Start voice conversation').click()
    await expect.poll(() => page.locator('.composer-mode-switch [role="status"]').innerText(), { timeout: 15_000 }).toBe('Listening')
    await page.context().setOffline(true)
    await page.getByLabel('Start voice conversation').waitFor({ state: 'visible' })
    await page.context().setOffline(false)
    expect(await page.getByLabel('Start voice conversation').getAttribute('aria-pressed')).toBe('false')
    result(await client.callTool({ name: 'create_book', arguments: { name: 'voice-other' } }))
    await page.getByLabel('Start voice conversation').click()
    await page.locator('.brand-project-menu-toggle').click()
    await page.getByRole('menuitem', { name: /voice-other/ }).click()
    await expect.poll(() => page.getByLabel('Start voice conversation').getAttribute('aria-pressed'), { timeout: 15_000 }).toBe('false')
    expect(await page.locator('.voice-captions p[data-role]').count()).toBe(0)
    const releases = await page.evaluate(() => performance.getEntriesByName('videobook-voice').filter(entry => (entry as PerformanceMark).detail.stage === 'microphone-released').map(entry => (entry as PerformanceMark).detail.ended))
    expect(releases.length).toBeGreaterThan(0)
    expect(releases.every(Boolean)).toBe(true)
  })
})
