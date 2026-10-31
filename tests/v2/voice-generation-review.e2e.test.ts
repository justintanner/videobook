import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { XaiRealtimeEndpoint } from '../../server/src/tools/xai-realtime-endpoint.js'
import { availablePort, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness'
import type { StartedProcess } from './e2e-harness'

const execFileAsync = promisify(execFile)
const timeout = 15_000

type Notebook = {
  cells: Array<{ id: string; type: string; slot: { row: number; column: number }; prompt?: string; inputs?: Record<string, unknown> }>
}

describe('voice generation review in the browser', () => {
  let root: string
  let browser: Browser
  let page: Page
  let client: Client
  let bookId: string
  let notebookId: string
  let turn = 0
  const endpoint = new XaiRealtimeEndpoint()
  const processes: StartedProcess[] = []
  const outcomes: Array<{ status: number; callId: string; outcome: { status: string } }> = []

  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return resultValue(await client.callTool({ name, arguments: { book_id: bookId, notebook_id: notebookId, ...args } })) as T
  }

  function speak(name: string, args: Record<string, unknown>, transcript: string): string {
    const callId = `generation-review-${++turn}`
    const send = (type: string, fields: Record<string, unknown>) => endpoint.send({ type, event_id: `${callId}-${type}`, ...fields })
    send('input_audio_buffer.speech_started', { item_id: callId })
    send('input_audio_buffer.speech_stopped', {})
    send('conversation.item.input_audio_transcription.completed', { item_id: callId, transcript })
    send('response.created', { response: { id: callId } })
    send('response.function_call_arguments.done', { response_id: callId, call_id: callId, name, arguments: JSON.stringify(args) })
    send('response.done', { response: { id: callId, status: 'completed' } })
    return callId
  }

  function output(callId: string): Record<string, unknown> | undefined {
    const item = endpoint.sent.find(event => event.type === 'conversation.item.create'
      && event.item?.type === 'function_call_output' && event.item.call_id === callId)?.item
    return item ? JSON.parse(String(item.output)) as Record<string, unknown> : undefined
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-voice-generation-review-'))
    const serverUrl = `http://127.0.0.1:${await availablePort()}`
    const appUrl = `http://127.0.0.1:${await availablePort()}`
    const server = startProcess(['--import', 'tsx', 'server/src/index.ts'], {
      ...process.env, PORT: new URL(serverUrl).port,
      OPENAI_API_KEY: '', KIE_API_KEY: '', XAI_API_KEY: 'local-endpoint-key', VIDEOBOOK_XAI_REALTIME_URL: await endpoint.listen(),
      VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json'),
    })
    processes.push(server)
    await waitForHttp(`${serverUrl}/healthz`, server, 200)
    client = new Client({ name: 'voice-generation-review', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`)))
    bookId = (await call<{ bookId: string }>('create_book', { name: 'voice-generation-review' })).bookId
    notebookId = (await call<Array<{ id: string }>>('list_notebooks'))[0]!.id
    const silencePath = join(root, 'silence.wav')
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '5', silencePath])
    const vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', new URL(appUrl).port, '--strictPort'], {
      ...process.env, VIDEOBOOK_SERVER_URL: serverUrl, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
    })
    processes.push(vite)
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${silencePath}`] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ['microphone'] })
    page.on('response', response => {
      if (!response.url().includes('/api/voice/') || !response.url().endsWith('/outcome')) return
      const body = response.request().postDataJSON() as { callId: string; outcome: { status: string } }
      outcomes.push({ status: response.status(), ...body })
    })
    await page.goto(appUrl)
    await page.getByLabel('Start voice conversation').waitFor({ state: 'visible', timeout: 30_000 })
    await page.evaluate(() => localStorage.setItem('videobook.cloud-generation-consent', 'accepted'))
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await endpoint.close()
    for (const process of processes.reverse()) await stopProcess(process)
    if (root) await rm(root, { recursive: true, force: true })
  }, 60_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page && !page.isClosed()) console.error(await page.locator('body').innerText())
  })

  it.each([
    { surface: 'spoken', decision: 'apply' },
    { surface: 'button', decision: 'apply' },
    { surface: 'spoken', decision: 'cancel' },
    { surface: 'button', decision: 'cancel' },
  ])('keeps voice live after revised generation $surface $decision and retains the inspector preview', async ({ surface, decision }) => {
    await page.reload({ waitUntil: 'commit' })
    await expect.poll(() => page.getByLabel('Start voice conversation').isEnabled(), { timeout }).toBe(true)
    await page.getByLabel('Voice provider', { exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'xAI', exact: true }).click()
    await page.getByLabel('Start voice conversation').click()
    await expect.poll(() => page.locator('.composer-mode-switch [role="status"]').innerText(), { timeout }).toBe('Listening')
    outcomes.length = 0
    const original = speak('prepare_workspace_action', {
      tool: 'generate_image', params: { prompt: 'A moonlit garden' },
    }, 'Generate an image of a moonlit garden')
    await expect.poll(() => output(original)?.status, { timeout }).toBe('review')
    const review = page.locator('.confirm-sheet .confirm-generation')
    let prompt = ''
    for (const index of [1, 2]) {
      prompt = `A moonlit garden with ${index} cats for ${surface} ${decision}`
      const revised = speak('resolve_pending_review', {
        decision: 'revise', prompt, settings: { aspect_ratio: '16:9', resolution: '2K' },
      }, `Change the image to ${prompt}, 16 by 9 and 2K`)
      await expect.poll(() => output(revised)?.status, { timeout }).toBe('review')
      await expect.poll(() => review.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue(), { timeout }).toBe(prompt)
    }
    let decisionCall: string | undefined
    if (surface === 'spoken') decisionCall = speak('resolve_pending_review', { decision }, `${decision} it`)
    else await page.locator('.confirm-sheet').getByRole('button', { name: decision === 'apply' ? /^Apply/ : /^Cancel/ }).click()
    const status = decision === 'apply' ? 'queued' : 'cancelled'
    await expect.poll(() => outcomes.find(result => result.callId === original && result.outcome.status === status)?.status, { timeout }).toBe(204)
    if (decisionCall) await expect.poll(() => output(decisionCall!)?.status, { timeout }).toBe(status)
    await expect.poll(() => page.locator('.confirm-sheet').count(), { timeout }).toBe(0)
    expect(outcomes.every(result => result.status === 204)).toBe(true)
    expect(await page.getByLabel('Stop voice conversation').isEnabled()).toBe(true)
    if (decision === 'apply') {
      const editor = page.locator('.generation-cell-inspector .confirm-generation')
      const payload = editor.locator('.generation-review-json pre')
      await expect.poll(() => payload.textContent(), { timeout }).toContain(prompt)
      await expect.poll(() => editor.locator('.generation-review-estimate-section').innerText(), { timeout }).toContain('$')
      expect(await editor.locator('.generation-review-estimate-section').innerText()).not.toContain('Updating')
      const notebook = await call<Notebook>('get_notebook')
      const cell = notebook.cells.find(candidate => candidate.type === 'generate_image' && candidate.prompt === prompt)!
      expect(cell).toBeDefined()
      const slot = { ...cell.slot, row: 10 + turn }
      await call('update_notebook_cell', { cell_id: cell.id, cell: { slot, inputs: { ...cell.inputs, resolvedPrompt: prompt, state: 'completed', runId: `preview-${turn}` } } })
      await page.bringToFront()
      await expect.poll(() => page.locator(`.react-flow__node[data-id="${cell.id}"] .cell-node-footer strong`).textContent(), { timeout }).toBe(notebookGridTag(slot))
      await expect.poll(() => payload.textContent(), { timeout }).toContain(prompt)
      expect(await editor.locator('.generation-review-estimate-section').innerText()).not.toContain('Updating')
    }
    await page.getByLabel('Stop voice conversation').click()
  }, 60_000)
})
